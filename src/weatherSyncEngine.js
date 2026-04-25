'use strict';

/**
 * Cloud sync for Weather Manager — same contract as Root Record Business Manager:
 * local `sync_outbox` → POST /v1/sync/push, GET /v1/sync/pull (license Worker + USER_DATA_DB).
 * Entity type `weather_data` is mirrored server-side into D1 table `weather_data`.
 */

const licenseService = require('./licenseService');

const SYNC_LAST_PULL_MS_KEY = 'sync_last_pull_ms';
const SYNC_LAST_PULL_AFTER_ID_KEY = 'sync_last_pull_after_id';
const MAX_BATCH = 50;
const SERVER_PULL_LIMIT = 200;

let sqlHelpers = null;
let syncDebounce = null;
/** Set from main (`wxGuestLocalSession`) so RootRecord cloud sync never runs without a verified account. */
let guestSessionGetter = () => false;

function bindSqlHelpers(h) {
  sqlHelpers = h;
}

function setGuestSessionGetter(fn) {
  guestSessionGetter = typeof fn === 'function' ? fn : () => false;
}

function isGuestOnlySession() {
  try {
    return Boolean(guestSessionGetter());
  } catch {
    return false;
  }
}

function nowUtcIsoText() {
  return new Date().toISOString().replace(/Z$/, '');
}

async function settingsGet(key, defaultVal) {
  if (!sqlHelpers) return defaultVal;
  try {
    const row = await sqlHelpers.getSql('SELECT value FROM app_settings WHERE key = ?', [key]);
    if (!row || row.value === undefined || row.value === null) return defaultVal;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return defaultVal;
  }
}

async function settingsSet(key, value) {
  if (!sqlHelpers) return;
  await sqlHelpers.runSql(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)]
  );
}

function sessionBearer() {
  const s = licenseService.loadSession();
  const t = s && s.access_token ? String(s.access_token).trim() : '';
  return t || null;
}

async function enqueueMutation(clientMutationId, entityType, entityKey, op, payload) {
  if (!sqlHelpers) return null;
  const cmid = String(clientMutationId || '').trim().slice(0, 120);
  if (!cmid) return null;
  const payloadJson = JSON.stringify(payload || {});
  const r = await sqlHelpers.runSql(
    `INSERT OR IGNORE INTO sync_outbox (
      client_mutation_id, user_id, entity_type, entity_key, op, payload_json, created_at_utc, status
    ) VALUES (?, 1, ?, ?, ?, ?, ?, 'pending')`,
    [cmid, String(entityType).slice(0, 120), String(entityKey).slice(0, 500), op, payloadJson, nowUtcIsoText()]
  );
  if (!r || !r.changes) return null;
  return cmid;
}

async function enqueueWeatherRowById(rowId) {
  if (!sqlHelpers || !Number.isFinite(Number(rowId))) return;
  const row = await sqlHelpers.getSql('SELECT * FROM rr_event_records WHERE id = ?', [rowId]);
  if (!row) return;
  const cmid = `wm-r-${row.id}`.slice(0, 120);
  const payload = {
    row_id: row.id,
    source: row.source,
    category: row.category,
    event_time: row.event_time,
    is_forecast: row.is_forecast,
    title: row.title,
    severity: row.severity,
    location_name: row.location_name,
    payload_json: row.payload_json
  };
  await enqueueMutation(cmid, 'weather_data', `weather_data:${row.id}`, 'upsert', payload);
}

async function pendingOutboxCount() {
  if (!sqlHelpers) return 0;
  const row = await sqlHelpers.getSql("SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'pending'");
  return row && row.n ? parseInt(row.n, 10) : 0;
}

async function flushSyncOutbox() {
  if (!sqlHelpers) return 0;
  if (isGuestOnlySession()) return 0;
  const bearer = sessionBearer();
  const baseUrl = licenseService.getLicenseApiBaseUrl();
  if (!bearer || !baseUrl) return 0;

  let deviceId;
  try {
    deviceId = licenseService.loadOrCreateDeviceId();
  } catch {
    return 0;
  }

  const rows = await sqlHelpers.allSql(
    `SELECT id, client_mutation_id, user_id, entity_type, entity_key, op, payload_json
     FROM sync_outbox WHERE status = 'pending' ORDER BY id LIMIT ?`,
    [MAX_BATCH]
  );
  if (!rows.length) return 0;

  const events = rows.map((r) => {
    let payload = {};
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      payload = {};
    }
    return {
      client_mutation_id: r.client_mutation_id,
      entity_type: r.entity_type,
      entity_key: r.entity_key,
      op: r.op === 'delete' ? 'delete' : 'upsert',
      payload
    };
  });

  const rowIds = rows.map((r) => r.id);
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/sync/push`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify({ device_id: deviceId, events })
    });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    const ph = rowIds.map(() => '?').join(',');
    await sqlHelpers.runSql(
      `UPDATE sync_outbox SET status = 'failed', last_error = ?, attempt_count = attempt_count + 1 WHERE id IN (${ph})`,
      [msg, ...rowIds]
    );
    return 0;
  }

  if (res.status === 401) return 0;

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    const msg = String(body.error?.message || body.message || res.status).slice(0, 500);
    const ph = rowIds.map(() => '?').join(',');
    await sqlHelpers.runSql(
      `UPDATE sync_outbox SET status = 'failed', last_error = ?, attempt_count = attempt_count + 1 WHERE id IN (${ph})`,
      [msg, ...rowIds]
    );
    return 0;
  }

  const accepted = Number(body.accepted != null ? body.accepted : events.length);
  const ph = rowIds.map(() => '?').join(',');
  await sqlHelpers.runSql(
    `UPDATE sync_outbox SET status = 'sent', last_error = NULL, attempt_count = attempt_count + 1 WHERE id IN (${ph})`,
    rowIds
  );

  return Math.min(accepted, events.length);
}

async function flushSyncOutboxUntilEmpty(maxRounds = 10000) {
  let total = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const n = await flushSyncOutbox();
    total += n;
    if (n === 0) break;
  }
  return total;
}

async function isMutationApplied(cmid) {
  if (!sqlHelpers) return false;
  const row = await sqlHelpers.getSql('SELECT 1 FROM sync_applied_remote WHERE client_mutation_id = ?', [
    String(cmid).slice(0, 200)
  ]);
  return Boolean(row);
}

async function markMutationApplied(cmid, reason) {
  if (!sqlHelpers) return;
  await sqlHelpers.runSql(
    `INSERT OR IGNORE INTO sync_applied_remote (client_mutation_id, applied_at_utc, reason) VALUES (?, ?, ?)`,
    [String(cmid).slice(0, 200), nowUtcIsoText(), String(reason || 'applied').slice(0, 80)]
  );
}

async function applyPulledEvents(events) {
  let myDevice = '';
  try {
    myDevice = licenseService.loadOrCreateDeviceId();
  } catch {
    myDevice = '';
  }

  let applied = 0;
  const list = Array.isArray(events) ? events.slice(0, SERVER_PULL_LIMIT) : [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    let cmid = raw.client_mutation_id;
    if (typeof cmid !== 'string' || !cmid.trim()) continue;
    cmid = cmid.trim().slice(0, 200);

    if (await isMutationApplied(cmid)) continue;

    const dev = raw.device_id;
    if (typeof dev === 'string' && dev.trim() && dev.trim() === myDevice) {
      await markMutationApplied(cmid, 'same_device');
      continue;
    }

    const entity = String(raw.entity_type || '');
    const op = String(raw.op || 'upsert');
    let payload = raw.payload;
    if (!payload || typeof payload !== 'object') payload = {};

    try {
      if (entity === 'weather_data' && op === 'delete') {
        const rid = Number(payload.row_id);
        if (Number.isFinite(rid)) {
          await sqlHelpers.runSql('DELETE FROM rr_event_records WHERE id = ?', [rid]);
        }
        await markMutationApplied(cmid, 'applied');
        applied += 1;
      } else if (entity === 'weather_data' && op !== 'delete') {
        let payloadJson = '{}';
        if (typeof payload.payload_json === 'string' && payload.payload_json.trim()) {
          payloadJson = payload.payload_json;
        } else {
          try {
            payloadJson = JSON.stringify(payload.record && typeof payload.record === 'object' ? payload.record : {});
          } catch {
            payloadJson = '{}';
          }
        }
        await sqlHelpers.runSql(
          `INSERT INTO rr_event_records (source, category, event_time, is_forecast, title, severity, location_name, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(payload.source || 'unknown'),
            String(payload.category || 'general'),
            payload.event_time != null ? String(payload.event_time) : null,
            Number(payload.is_forecast) ? 1 : 0,
            payload.title != null ? String(payload.title) : null,
            payload.severity != null ? String(payload.severity) : null,
            payload.location_name != null ? String(payload.location_name) : null,
            payloadJson
          ]
        );
        await markMutationApplied(cmid, 'applied');
        applied += 1;
      } else {
        await markMutationApplied(cmid, 'skipped_unsupported');
      }
    } catch {
      await markMutationApplied(cmid, 'skipped_apply_failed');
    }
  }

  return applied;
}

async function pullRemoteChanges() {
  if (!sqlHelpers) return { received: 0, applied: 0 };
  if (isGuestOnlySession()) return { received: 0, applied: 0 };
  const bearer = sessionBearer();
  const baseUrl = licenseService.getLicenseApiBaseUrl();
  if (!bearer || !baseUrl) return { received: 0, applied: 0 };

  let sinceMs = 0;
  try {
    const raw = await settingsGet(SYNC_LAST_PULL_MS_KEY, '0');
    sinceMs = parseInt(String(raw || '0').trim(), 10) || 0;
  } catch {
    sinceMs = 0;
  }

  let afterId = '';
  try {
    const aid = await settingsGet(SYNC_LAST_PULL_AFTER_ID_KEY, '');
    afterId = String(aid || '').trim().slice(0, 128);
  } catch {
    afterId = '';
  }

  let totalReceived = 0;
  let totalApplied = 0;

  for (;;) {
    const params = new URLSearchParams();
    params.set('since_ms', String(sinceMs));
    if (afterId) params.set('after_id', afterId);

    const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/sync/pull?${params.toString()}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}` }
      });
    } catch {
      break;
    }

    if (res.status === 401) break;

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) break;

    const evs = Array.isArray(data.events) ? data.events : [];
    totalReceived += evs.length;
    totalApplied += await applyPulledEvents(evs);

    if (evs.length === 0) break;

    const last = evs[evs.length - 1];
    const ct = typeof last.created_at === 'number' ? last.created_at : sinceMs;
    const lid = typeof last.id === 'string' ? last.id.trim().slice(0, 128) : '';

    sinceMs = ct;
    afterId = lid;
    await settingsSet(SYNC_LAST_PULL_MS_KEY, String(sinceMs));
    await settingsSet(SYNC_LAST_PULL_AFTER_ID_KEY, afterId);

    if (evs.length < SERVER_PULL_LIMIT) break;
    if (!lid) break;
  }

  return { received: totalReceived, applied: totalApplied };
}

async function syncCycleBestEffort() {
  if (isGuestOnlySession()) return { pushed: 0, pulled: 0, applied: 0 };
  const pushed = await flushSyncOutboxUntilEmpty();
  const pull = await pullRemoteChanges();
  return { pushed, pulled: pull.received, applied: pull.applied };
}

function scheduleSync() {
  if (syncDebounce) clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => {
    syncDebounce = null;
    syncCycleBestEffort().catch(() => {});
  }, 900);
}

async function enqueueStoredRowIds(rowIds) {
  if (isGuestOnlySession()) return;
  if (!Array.isArray(rowIds) || !rowIds.length) return;
  for (const id of rowIds) {
    await enqueueWeatherRowById(id);
  }
}

module.exports = {
  bindSqlHelpers,
  setGuestSessionGetter,
  enqueueStoredRowIds,
  scheduleSync,
  syncCycleBestEffort
};

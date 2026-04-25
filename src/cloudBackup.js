'use strict';

/**
 * Optional online backup of local SQLite copies — mirrors Root Record Business Manager
 * (backup_r2_client.py): same worker routes and env precedence.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SETTINGS_KEY = 'rootrecordCloudBackupSettings';

const SHIPPED_BACKUP_API_BASE_URL = 'https://rootrecord-desktop-backup.wildecho94.workers.dev';

const _BACKUP_HEALTH = '/v1/backup/health';
const _BACKUP_UPLOAD = '/v1/backup/upload';

function defaultSettings() {
  return {
    cloud_backup_enabled: false,
    cloud_backup_api_base_url: '',
    cloud_backup_vault_token: '',
    cloud_backup_last_upload_utc: '',
    cloud_backup_last_source_mtime_ns: '0',
    cloud_backup_last_object_key: '',
    cloud_backup_last_error: '',
    auto_backup_enabled: false,
    auto_backup_interval_hours: 24,
    last_backup_utc: '',
    last_backup_reason: ''
  };
}

function readSettings(store) {
  const raw = store.get(SETTINGS_KEY, null);
  if (!raw || typeof raw !== 'object') return { ...defaultSettings() };
  return { ...defaultSettings(), ...raw };
}

function writeSettings(store, partial) {
  const next = { ...readSettings(store), ...partial };
  store.set(SETTINGS_KEY, next);
  return next;
}

function nowIsoZ() {
  return new Date().toISOString().replace(/\+00:00$/, 'Z');
}

function statMtimeNs(st) {
  if (st && typeof st.mtimeNs === 'bigint') return Number(st.mtimeNs);
  return Math.round(Number(st.mtimeMs) * 1e6);
}

function backupApiBaseUrl(store, licenseApiBaseUrl) {
  const envFirst = String(process.env.ROOTRECORD_BACKUP_API_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (envFirst) return envFirst;
  const ship = String(SHIPPED_BACKUP_API_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (ship) return ship;
  const s = readSettings(store);
  const dbUrl = String(s.cloud_backup_api_base_url || '')
    .trim()
    .replace(/\/+$/, '');
  if (dbUrl) return dbUrl;
  const lic = String(licenseApiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  return lic || '';
}

function cloudBackupEnabled(store) {
  return Boolean(readSettings(store).cloud_backup_enabled);
}

function vaultToken(store) {
  return String(readSettings(store).cloud_backup_vault_token || '').trim();
}

function ensureVaultToken(store) {
  let tok = vaultToken(store);
  if (tok.length >= 24) return tok;
  tok = crypto.randomBytes(32).toString('base64url');
  writeSettings(store, { cloud_backup_vault_token: tok });
  return tok;
}

function bootstrapIfEnabled(store, licenseApiBaseUrl) {
  if (!cloudBackupEnabled(store)) return;
  if (!backupApiBaseUrl(store, licenseApiBaseUrl)) return;
  ensureVaultToken(store);
}

async function pingBackupService(base) {
  const url = `${base}${_BACKUP_HEALTH}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(url, { method: 'GET', signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, message: 'Request timed out.' };
    return { ok: false, message: String(e && e.message ? e.message : e).slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status !== 200) {
    return { ok: false, message: `HTTP ${response.status}` };
  }
  if (!body || typeof body !== 'object' || body.ok !== true) {
    return { ok: false, message: 'unexpected JSON' };
  }
  const r2 = String(body.r2 || 'ready')
    .trim()
    .toLowerCase();
  if (r2 === 'unconfigured') {
    return { ok: false, message: 'R2 bucket is not bound on the backup worker.' };
  }
  return { ok: true, message: 'ok' };
}

function parseUploadErrorBody(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      const err = j.error;
      if (err && typeof err === 'object' && err.message) return String(err.message).slice(0, 400);
      if (typeof err === 'string') return err.slice(0, 400);
    }
  } catch {
    /* ignore */
  }
  return '';
}

async function uploadSqliteFile(store, filePath, filename, licenseApiBaseUrl) {
  if (!cloudBackupEnabled(store)) {
    return { ok: false, message: 'Turn on online backup in Settings.' };
  }
  const base = backupApiBaseUrl(store, licenseApiBaseUrl);
  if (!base) {
    return { ok: false, message: 'Online backup is not available on this copy.' };
  }
  const tok = vaultToken(store);
  if (tok.length < 24) {
    return { ok: false, message: 'Turn on online backup and save backup settings first.' };
  }
  const ping = await pingBackupService(base);
  if (!ping.ok) {
    return { ok: false, message: 'Could not reach RootRecord online backup. Check your internet connection.' };
  }
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return { ok: false, message: 'The backup file was not found.' };
  }
  const name = String(filename || path.basename(filePath)).slice(0, 200);
  const url = `${base}${_BACKUP_UPLOAD}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/vnd.sqlite3',
        'X-RootRecord-Filename': name
      },
      body: data,
      signal: controller.signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      writeSettings(store, { cloud_backup_last_error: 'Upload timed out.' });
      return { ok: false, message: 'The online copy could not be saved. Try again later.' };
    }
    const err = String(e && e.message ? e.message : e).slice(0, 400);
    writeSettings(store, { cloud_backup_last_error: err });
    return { ok: false, message: 'The online copy could not be saved. Try again later.' };
  } finally {
    clearTimeout(timeout);
  }
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }
  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    payload = null;
  }
  if (response.status !== 200 && response.status !== 201) {
    const parsed = bodyText ? parseUploadErrorBody(bodyText.slice(0, 800)) : '';
    if (parsed) {
      writeSettings(store, { cloud_backup_last_error: `HTTP ${response.status}: ${parsed}` });
      return { ok: false, message: `Online backup failed: ${parsed}` };
    }
    writeSettings(store, { cloud_backup_last_error: `HTTP ${response.status}` });
    return { ok: false, message: 'The online copy could not be saved. Try again later.' };
  }
  const st = fs.statSync(filePath);
  const mtimeNs = String(statMtimeNs(st));
  writeSettings(store, {
    cloud_backup_last_upload_utc: nowIsoZ(),
    cloud_backup_last_source_mtime_ns: mtimeNs,
    cloud_backup_last_error: ''
  });
  if (payload && typeof payload === 'object' && typeof payload.key === 'string') {
    writeSettings(store, { cloud_backup_last_object_key: String(payload.key).slice(0, 500) });
  }
  return { ok: true, message: 'Saved.' };
}

function newestLocalBackupFile(backupsDir) {
  try {
    if (!backupsDir || !fs.existsSync(backupsDir)) return null;
    const names = fs.readdirSync(backupsDir);
    let best = null;
    let bestMs = 0;
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.sqlite3')) continue;
      const full = path.join(backupsDir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const ms = Number(st.mtimeMs);
        if (ms >= bestMs) {
          bestMs = ms;
          best = full;
        }
      } catch {
        /* ignore */
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function maybeUploadNewestIfStale(store, backupsDir, licenseApiBaseUrl) {
  if (!cloudBackupEnabled(store)) {
    return { ok: false, message: 'Online backup is off.' };
  }
  if (!backupApiBaseUrl(store, licenseApiBaseUrl)) {
    return { ok: false, message: 'Online backup is not available on this copy.' };
  }
  if (vaultToken(store).length < 24) {
    return { ok: false, message: 'Save backup settings with online backup turned on.' };
  }
  const p = newestLocalBackupFile(backupsDir);
  if (!p) {
    return { ok: false, message: 'No local backup yet.' };
  }
  let lastNs = 0;
  try {
    lastNs = parseInt(String(readSettings(store).cloud_backup_last_source_mtime_ns || '0') || '0', 10) || 0;
  } catch {
    lastNs = 0;
  }
  const curNs = statMtimeNs(fs.statSync(p));
  if (curNs <= lastNs) {
    return { ok: false, message: 'Already up to date.' };
  }
  return uploadSqliteFile(store, p, path.basename(p), licenseApiBaseUrl);
}

function cloudBackupStatusSummary(store, backupsDir, licenseApiBaseUrl) {
  const lines = [];
  if (!cloudBackupEnabled(store)) {
    lines.push('Online backup copy: off.');
    return lines.join('\n');
  }
  const base = backupApiBaseUrl(store, licenseApiBaseUrl);
  if (!base) {
    lines.push('Online backup: no service URL (set ROOTRECORD_BACKUP_API_BASE_URL or use shipped default).');
    return lines.join('\n');
  }
  lines.push(`Service: ${base.length > 72 ? `${base.slice(0, 72)}…` : base}`);
  if (vaultToken(store).length < 24) {
    lines.push('Vault token missing: turn online backup on and save backup settings.');
  } else {
    lines.push('Use “Test connection” below to verify the worker can reach R2.');
  }
  const s = readSettings(store);
  lines.push(`Last successful upload: ${String(s.cloud_backup_last_upload_utc || '').trim() || 'never'}`);
  const key = String(s.cloud_backup_last_object_key || '').trim();
  if (key) {
    lines.push(`Last object key: ${key.length > 100 ? `${key.slice(0, 100)}…` : key}`);
  }
  const err = String(s.cloud_backup_last_error || '').trim();
  if (err) {
    lines.push(`Last error: ${err.length > 220 ? `${err.slice(0, 220)}…` : err}`);
  }
  const p = newestLocalBackupFile(backupsDir);
  if (!p) {
    lines.push('No local *.sqlite3 backup found yet. Run “Backup database now” or enable automatic backups.');
  } else {
    lines.push(`Latest local backup file: ${path.basename(p)}`);
  }
  return lines.join('\n');
}

/**
 * SQLite-consistent snapshot using VACUUM INTO (same idea as Python sqlite3.backup).
 */
function performLocalDatabaseBackupSafe(db, backupsDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = nowIsoZ().replace(/[:]/g, '-');
    const outPath = path.join(backupsDir, `weather-manager-backup-${stamp}.sqlite3`);
    const canonical = path.resolve(outPath);
    const forSql = canonical.replace(/\\/g, '/').replace(/'/g, "''");
    db.run(`VACUUM INTO '${forSql}'`, (err) => {
      if (err) return reject(err);
      resolve(canonical);
    });
  });
}

async function scheduleUploadAfterLocalBackup(store, filePath, licenseApiBaseUrl) {
  if (!cloudBackupEnabled(store)) return { ok: false, skipped: true };
  return uploadSqliteFile(store, filePath, path.basename(filePath), licenseApiBaseUrl);
}

function autoBackupDue(store) {
  const s = readSettings(store);
  if (!s.auto_backup_enabled) return false;
  let everyH = 24;
  try {
    everyH = parseInt(String(s.auto_backup_interval_hours || 24), 10) || 24;
  } catch {
    everyH = 24;
  }
  everyH = Math.max(1, everyH);
  const lastS = String(s.last_backup_utc || '').trim();
  if (!lastS) return true;
  try {
    const lastMs = Date.parse(lastS.endsWith('Z') ? lastS : lastS.replace(/\.\d+$/, ''));
    if (Number.isNaN(lastMs)) return true;
    return Date.now() - lastMs >= everyH * 3600 * 1000;
  } catch {
    return true;
  }
}

module.exports = {
  SETTINGS_KEY,
  SHIPPED_BACKUP_API_BASE_URL,
  readSettings,
  writeSettings,
  backupApiBaseUrl,
  cloudBackupEnabled,
  vaultToken,
  ensureVaultToken,
  bootstrapIfEnabled,
  pingBackupService,
  uploadSqliteFile,
  newestLocalBackupFile,
  maybeUploadNewestIfStale,
  cloudBackupStatusSummary,
  performLocalDatabaseBackupSafe,
  scheduleUploadAfterLocalBackup,
  autoBackupDue,
  nowIsoZ
};

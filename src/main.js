const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dns = require('dns');
/** Windows + Cloudflare often resolve AAAA first; broken IPv6 yields undici ConnectTimeoutError on fetch(). */
try {
  if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
} catch {
  /* ignore */
}
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const cloudBackup = require('./cloudBackup');
const licenseService = require('./licenseService');
const weatherSync = require('./weatherSyncEngine');
const { setupAutoUpdater, checkForUpdatesInteractive } = require('./autoUpdate');

/** Taskbar / Jump List / shortcut shell identity — must match `build.appId` in package.json (NSIS). */
const WIN_APP_USER_MODEL_ID = 'com.rootrecord.weather-manager';

/** Taskbar / Jump List identity on Windows — must run before any BrowserWindow is created. */
if (process.platform === 'win32') {
  app.setAppUserModelId(WIN_APP_USER_MODEL_ID);
}

/**
 * App data folder (electron-store, SQLite, runtime UI HTML).
 * Aligns with Root Record Business Manager: %USERPROFILE%\RootRecord\Weather Manager (override ROOTRECORD_HOME or RR_WEATHER_HOME).
 * Legacy default was %LOCALAPPDATA%\RootRecord\Weather Manager — see migrateLegacyWindowsWeatherManagerHomeIfNeeded().
 */
function resolveWeatherManagerHome() {
  const directHome = String(process.env.RR_WEATHER_HOME || '').trim();
  if (directHome) return path.resolve(directHome);
  const installedPointer = path.join(path.dirname(process.execPath), 'weather-manager-data-path.txt');
  try {
    if (fs.existsSync(installedPointer)) {
      const customPath = String(fs.readFileSync(installedPointer, 'utf8') || '').trim();
      if (customPath) return path.resolve(customPath);
    }
  } catch {
    // Ignore pointer read errors and continue with default path logic.
  }
  const envHome = String(process.env.ROOTRECORD_HOME || '').trim();
  if (envHome) return path.join(path.resolve(envHome), 'Weather Manager');
  const userProfile = String(process.env.USERPROFILE || os.homedir() || '').trim();
  if (userProfile) {
    return path.join(userProfile, 'RootRecord', 'Weather Manager');
  }
  return path.join(app.getPath('home'), 'RootRecord', 'Weather Manager');
}

/**
 * One-time: copy older LocalAppData data into the profile RootRecord folder when the new location has no DB yet.
 * Skipped if RR_WEATHER_HOME, ROOTRECORD_HOME, exe pointer, or non-default target path.
 */
function migrateLegacyWindowsWeatherManagerHomeIfNeeded(targetHome) {
  if (process.platform !== 'win32') return;
  if (String(process.env.RR_WEATHER_HOME || '').trim()) return;
  if (String(process.env.ROOTRECORD_HOME || '').trim()) return;

  const profile = String(process.env.USERPROFILE || os.homedir() || '').trim();
  if (!profile) return;
  const expectedDefault = path.join(profile, 'RootRecord', 'Weather Manager');
  if (path.resolve(targetHome) !== path.resolve(expectedDefault)) return;

  const local = String(process.env.LOCALAPPDATA || '').trim();
  if (!local) return;
  const legacyHome = path.join(local, 'RootRecord', 'Weather Manager');
  if (!fs.existsSync(legacyHome)) return;

  const newDb = path.join(targetHome, 'weather-manager.db');
  if (fs.existsSync(newDb)) return;

  const legacyDb = path.join(legacyHome, 'weather-manager.db');
  const legacyConfig = path.join(legacyHome, 'config.json');
  if (!fs.existsSync(legacyDb) && !fs.existsSync(legacyConfig)) return;

  try {
    fs.mkdirSync(targetHome, { recursive: true });
    fs.cpSync(legacyHome, targetHome, { recursive: true });
  } catch (e) {
    console.error('RootRecord Weather Manager: could not migrate data from LocalAppData to user profile:', e);
  }
}

const WEATHER_MANAGER_HOME = resolveWeatherManagerHome();
migrateLegacyWindowsWeatherManagerHomeIfNeeded(WEATHER_MANAGER_HOME);
fs.mkdirSync(WEATHER_MANAGER_HOME, { recursive: true });
try {
  app.setPath('userData', WEATHER_MANAGER_HOME);
} catch {
  // Ignore path override issues and continue.
}

const store = new Store({ cwd: WEATHER_MANAGER_HOME });
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(WIN_APP_USER_MODEL_ID);
  } catch {
    /* ignore */
  }
}
let mainWindow;
let alertWindow;
let db;
/** Serialize DB writes: parallel `store-records` IPC (e.g. Promise.all refresh) must not nest BEGIN TRANSACTION on one connection. */
let storeRecordsQueue = Promise.resolve();

function getMainWindow() {
  return mainWindow || null;
}

const LOCATION_CONFIG_KEY = 'weatherLocationConfig';
const DATA_ARCHIVE_KEY = 'weatherDataArchive';
const OPEN_AT_LOGIN_KEY = 'openAtLogin';

/** Cleared when the app quits. User chose local-only without saving a Root Record session (sign-in gate returns next launch). */
let wxGuestLocalSession = false;

/** Persisted: last time a guest session completed any live hazard API fetch (NOAA/USGS/etc.). */
const GUEST_PUBLIC_DATA_LAST_FETCH_MS_KEY = 'guestPublicDataLastFetchMs';
/** Guest sessions may run one coordinated refresh burst (parallel IPCs) then wait 24h. */
const GUEST_PUBLIC_DATA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Allow parallel `fetch-*` handlers from a single user refresh without counting each HTTP call separately. */
const GUEST_PUBLIC_DATA_BURST_MS = 12 * 60 * 1000;
let guestPublicDataBurstUntilMs = 0;
/** True after guest assert opens a burst window; cleared when the renderer commits the refresh cycle. */
let guestPublicDataBurstOpened = false;

function resetGuestPublicDataThrottleState() {
  guestPublicDataBurstUntilMs = 0;
  guestPublicDataBurstOpened = false;
}

function assertGuestPublicDataFetchAllowed() {
  if (!wxGuestLocalSession) return;
  const now = Date.now();
  if (now < guestPublicDataBurstUntilMs) return;
  const last = Number(store.get(GUEST_PUBLIC_DATA_LAST_FETCH_MS_KEY, 0)) || 0;
  if (last > 0 && now - last < GUEST_PUBLIC_DATA_COOLDOWN_MS) {
    const remaining = GUEST_PUBLIC_DATA_COOLDOWN_MS - (now - last);
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.max(1, Math.ceil((remaining % 3600000) / 60000));
    const parts = [];
    if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    if (hours === 0 || minutes < 60) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    const err = new Error(
      `Without a Root Record account, live hazard data (NOAA, USGS, NASA EONET, etc.) can be refreshed once per 24 hours. Try again in about ${parts.join(
        ' and '
      )}. Sign in for automatic refreshes and unlimited manual updates.`
    );
    err.code = 'GUEST_PUBLIC_DATA_COOLDOWN';
    throw err;
  }
  guestPublicDataBurstUntilMs = now + GUEST_PUBLIC_DATA_BURST_MS;
  guestPublicDataBurstOpened = true;
}

function commitGuestLiveRefreshCycle() {
  if (!wxGuestLocalSession) return;
  if (!guestPublicDataBurstOpened) return;
  guestPublicDataBurstOpened = false;
  store.set(GUEST_PUBLIC_DATA_LAST_FETCH_MS_KEY, Date.now());
  guestPublicDataBurstUntilMs = 0;
}

// Match Business Manager shipped default; env var still overrides this.
const SHIPPED_CORE_API_BASE_URL = 'https://rootrecord-license.wildecho94.workers.dev';
const CORE_API_BASE_URL = String(process.env.LICENSE_API_BASE_URL || SHIPPED_CORE_API_BASE_URL).trim();
const CORE_API_SHARED_BEARER = String(process.env.LICENSE_API_SECRET || '').trim();
/** Directories scanned for critical-alert clips (first match per filename wins). */
function getAlertSoundScanDirs() {
  const dirs = [];
  const pushDir = (p) => {
    const s = String(p || '').trim();
    if (!s) return;
    try {
      const abs = path.resolve(s);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) dirs.push(abs);
    } catch {
      /* ignore */
    }
  };
  pushDir(process.env.RR_ALERT_SOUNDS_DIR);
  if (app.isPackaged) {
    pushDir(path.join(process.resourcesPath, 'notification-sounds'));
  }
  pushDir(path.join(__dirname, '..', 'assets', 'notification-sounds'));
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

function weatherBackupsDir() {
  return path.join(app.getPath('userData'), 'backups');
}

async function weatherRunLocalBackup(reason) {
  if (!db) throw new Error('Database is not ready.');
  const dir = weatherBackupsDir();
  let outPath;
  try {
    outPath = await cloudBackup.performLocalDatabaseBackupSafe(db, dir);
  } catch (e1) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = cloudBackup.nowIsoZ().replace(/[:]/g, '-');
      const dest = path.join(dir, `weather-manager-backup-${stamp}.sqlite3`);
      const dbPath = path.join(app.getPath('userData'), 'weather-manager.db');
      fs.copyFileSync(dbPath, dest);
      outPath = path.resolve(dest);
    } catch (e2) {
      throw e1 || e2;
    }
  }
  cloudBackup.writeSettings(store, {
    last_backup_utc: cloudBackup.nowIsoZ(),
    last_backup_reason: String(reason || 'manual')
  });
  return { ok: true, path: outPath };
}

async function weatherMaybeAutoBackup() {
  try {
    if (!db) return;
    if (!cloudBackup.autoBackupDue(store)) return;
    await weatherRunLocalBackup('auto');
  } catch (e) {
    console.error('RootRecord Weather Manager: auto backup failed:', e);
  }
}

let weatherBackupTimersStarted = false;
function startWeatherBackupMaintenance() {
  if (weatherBackupTimersStarted) return;
  weatherBackupTimersStarted = true;
  try {
    cloudBackup.writeSettings(store, {
      cloud_backup_enabled: false,
      cloud_backup_api_base_url: ''
    });
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    void weatherMaybeAutoBackup();
  }, 1200);
  setInterval(() => {
    void weatherMaybeAutoBackup();
  }, 60 * 60 * 1000);
}

function initLocalDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'weather-manager.db');
  db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS rr_event_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        event_time TEXT,
        is_forecast INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        severity TEXT,
        location_name TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_source ON rr_event_records(source)');
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_category ON rr_event_records(category)');
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_forecast ON rr_event_records(is_forecast)');
    db.run('CREATE INDEX IF NOT EXISTS idx_rr_event_records_event_time ON rr_event_records(event_time)');
    db.run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        client_mutation_id TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL DEFAULT 1,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
        payload_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
        last_error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox (status, created_at_utc)");
    db.run('CREATE INDEX IF NOT EXISTS idx_sync_outbox_user ON sync_outbox (user_id, status)');
    db.run(`
      CREATE TABLE IF NOT EXISTS sync_applied_remote (
        client_mutation_id TEXT NOT NULL PRIMARY KEY,
        applied_at_utc TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'applied'
      )
    `);
  });
  weatherSync.bindSqlHelpers({ runSql, allSql, getSql });
  weatherSync.setGuestSessionGetter(() => wxGuestLocalSession);
}

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function allSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function getSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getCoreApiBaseUrlOrThrow() {
  if (!CORE_API_BASE_URL) {
    throw new Error('Core auth API is not configured. Set LICENSE_API_BASE_URL.');
  }
  return CORE_API_BASE_URL.replace(/\/+$/, '');
}

async function coreApiJson(pathname, body, token, method = 'POST') {
  const base = getCoreApiBaseUrlOrThrow();
  const headers = { 'Content-Type': 'application/json' };
  const bearer = String(token || '').trim() || CORE_API_SHARED_BEARER;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Core auth request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    if (payload && typeof payload === 'object') {
      if (typeof payload.error === 'string') message = payload.error;
      if (payload.error && typeof payload.error === 'object' && payload.error.message) message = String(payload.error.message);
      if (payload.message) message = String(payload.message);
    }
    throw new Error(message);
  }
  return payload || {};
}

/** One-time: legacy electron-store session → same `license_session.json` + `.license_device_id` as Business Manager. */
function migrateLegacyStoreAuthToLicenseSessionOnce() {
  try {
    const root = app.getPath('userData');
    const lsPath = path.join(root, 'license_session.json');
    if (fs.existsSync(lsPath)) return;
    const tok = String(store.get('coreAuthSessionToken', '') || '').trim();
    const email = String(store.get('coreAuthEmail', '') || '').trim();
    if (!tok || !email) return;
    const stub = {
      access_token: tok,
      email,
      account_id: '',
      me: null,
      last_entitlement_check_utc: null
    };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lsPath, JSON.stringify(stub, null, 2), 'utf8');
    store.delete('coreAuthSessionToken');
    store.delete('coreAuthEmail');
    const licDevPath = path.join(root, '.license_device_id');
    if (!fs.existsSync(licDevPath)) {
      const oldDev = String(store.get('coreAuthDeviceId', '') || '').trim();
      if (oldDev) fs.writeFileSync(licDevPath, oldDev, 'utf8');
      store.delete('coreAuthDeviceId');
    }
  } catch {
    /* non-fatal */
  }
}

function trialRemainingText(trialEndsAt) {
  if (!trialEndsAt) return '';
  const end = new Date(trialEndsAt);
  if (Number.isNaN(end.getTime())) return '';
  const now = new Date();
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return 'Included access ended';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / (60 * 24));
  const hours = Math.floor((mins - days * 24 * 60) / 60);
  if (days > 0) return `${days}d ${hours}h remaining`;
  return `${Math.max(0, hours)}h remaining`;
}

function weatherEntitlementFromPrep(prep) {
  if (!prep || typeof prep !== 'object') {
    return { allow: false, access: '', reason: '', trialEndsAt: null, trialRemaining: '', proUnlocked: false };
  }
  const access = String(prep.access || '').toLowerCase();
  const reason = String(prep.reason || '').toLowerCase();
  const trialEndsAt = prep.trialEndsAt ?? null;
  return {
    allow: access === 'full',
    access,
    reason,
    trialEndsAt,
    trialRemaining: trialRemainingText(trialEndsAt),
    proUnlocked: Boolean(prep.proUnlocked),
    raw: prep
  };
}

async function weatherAuthStateFromLicense() {
  if (wxGuestLocalSession) {
    return {
      authenticated: true,
      guestLocal: true,
      email: '',
      message: '',
      entitlement: {
        allow: true,
        access: 'guest_local',
        reason: 'guest_local',
        trialRemaining: '',
        proUnlocked: false
      }
    };
  }
  const prep = await licenseService.prepare({});
  if (prep && prep.configured === false) {
    return {
      authenticated: false,
      email: '',
      message: String(prep.message || 'Online sign-in is not set up in this app.').trim(),
      entitlement: null
    };
  }
  const sess = licenseService.loadSession();
  const email = String((sess && sess.email) || prep.email || '').trim();
  if (!prep.authenticated) {
    const fallback =
      prep.ok === false && prep.configured
        ? 'Could not confirm account access right now.'
        : 'Sign in or create an account to continue.';
    return {
      authenticated: false,
      email,
      message: String((prep.message && prep.message.trim()) || fallback).trim(),
      entitlement: weatherEntitlementFromPrep({ access: '', reason: '' })
    };
  }
  const ent = weatherEntitlementFromPrep(prep);
  if (!ent.allow) {
    const msg =
      ent.reason === 'past_due'
        ? 'Billing on this account needs attention before Weather Manager can open. Visit RootRecord.com to update payment.'
        : 'Weather Manager could not open with this account yet. Sign in again or check your account on RootRecord.com.';
    return { authenticated: false, email, message: msg, entitlement: ent };
  }
  let message = '';
  if (prep.isTrial && prep.trialEndsAt) {
    message = `Signed in (${trialRemainingText(prep.trialEndsAt)}).`;
  } else if (prep.warning && prep.offlineGrace) {
    message = String(prep.warning || '').trim();
  }
  return { authenticated: true, email, message, entitlement: ent };
}

async function weatherPostLoginSnapshot() {
  const prep = await licenseService.prepare({ forceRefresh: true });
  const ent = weatherEntitlementFromPrep(prep);
  return {
    ok: true,
    email: String(prep.email || '').trim(),
    entitlement: ent
  };
}

async function storeRecords(records, meta) {
  if (!db || !Array.isArray(records) || !records.length) return;
  const insertedIds = [];
  await runSql('BEGIN TRANSACTION');
  try {
    for (const record of records) {
      const ins = await runSql(
        `INSERT INTO rr_event_records
          (source, category, event_time, is_forecast, title, severity, location_name, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(meta.source || 'unknown'),
          String(meta.category || 'general'),
          record && record.eventTime ? String(record.eventTime) : null,
          meta.isForecast ? 1 : 0,
          record && record.title ? String(record.title) : null,
          record && record.severity ? String(record.severity) : null,
          record && record.locationName ? String(record.locationName) : null,
          JSON.stringify(record || {})
        ]
      );
      if (ins && ins.lastID) insertedIds.push(ins.lastID);
    }
    await runSql('COMMIT');
  } catch (error) {
    await runSql('ROLLBACK');
    throw error;
  }
  if (!wxGuestLocalSession) {
    try {
      await weatherSync.enqueueStoredRowIds(insertedIds);
      weatherSync.scheduleSync();
    } catch {
      /* non-fatal cloud queue */
    }
  }
}

function applyOpenAtLoginSetting() {
  if (process.platform !== 'win32') return;
  const enabled = Boolean(store.get(OPEN_AT_LOGIN_KEY, false));
  const options = { openAtLogin: enabled };
  if (process.defaultApp) {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  } else {
    options.path = process.execPath;
  }
  try {
    app.setLoginItemSettings(options);
  } catch {
    // Ignore login registration failures to avoid blocking app startup.
  }
}

function defaultConfig() {
  return {
    isConfigured: false,
    radiusMiles: 150,
    unitSystem: 'imperial',
    criticalAlerts: {
      weatherEnabled: true,
      usgsEnabled: true,
      usgsMinMagnitude: 5.0,
      usgsMaxDistanceMiles: 200,
      soundPath: ''
    },
    locations: []
  };
}

function readLocationConfig() {
  const cfg = store.get(LOCATION_CONFIG_KEY, defaultConfig());
  if (!cfg || typeof cfg !== 'object') return defaultConfig();
  if (!Array.isArray(cfg.locations)) return defaultConfig();
  const radius = Number(cfg.radiusMiles);
  const unitSystem = String(cfg.unitSystem || '').toLowerCase() === 'metric' ? 'metric' : 'imperial';
  const alerts = cfg.criticalAlerts && typeof cfg.criticalAlerts === 'object' ? cfg.criticalAlerts : {};
  const usgsMinMagnitude = Number(alerts.usgsMinMagnitude);
  const usgsMaxDistanceMiles = Number(alerts.usgsMaxDistanceMiles);
  const soundPath = String(alerts.soundPath || '').trim();
  return {
    isConfigured: Boolean(cfg.isConfigured),
    radiusMiles: Number.isFinite(radius) && radius > 0 ? radius : 150,
    unitSystem,
    criticalAlerts: {
      weatherEnabled: alerts.weatherEnabled !== false,
      usgsEnabled: alerts.usgsEnabled !== false,
      usgsMinMagnitude: Number.isFinite(usgsMinMagnitude) ? Math.max(0, usgsMinMagnitude) : 5.0,
      usgsMaxDistanceMiles: Number.isFinite(usgsMaxDistanceMiles) && usgsMaxDistanceMiles > 0 ? usgsMaxDistanceMiles : 200,
      soundPath
    },
    locations: cfg.locations
      .map((loc) => ({
        name: String(loc.name || '').trim(),
        latitude: Number(loc.latitude),
        longitude: Number(loc.longitude)
      }))
      .filter((loc) => loc.name && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude))
  };
}

function defaultArchive() {
  return {
    noaa: [],
    usgs: [],
    canada: [],
    tsunamis: [],
    noaaDashboard: [],
    cyclones: [],
    wildfires: [],
    forecasts: []
  };
}

function readArchive() {
  const archive = store.get(DATA_ARCHIVE_KEY, defaultArchive());
  if (!archive || typeof archive !== 'object') return defaultArchive();
  return {
    noaa: Array.isArray(archive.noaa) ? archive.noaa : [],
    usgs: Array.isArray(archive.usgs) ? archive.usgs : [],
    canada: Array.isArray(archive.canada) ? archive.canada : [],
    tsunamis: Array.isArray(archive.tsunamis) ? archive.tsunamis : [],
    noaaDashboard: Array.isArray(archive.noaaDashboard) ? archive.noaaDashboard : [],
    cyclones: Array.isArray(archive.cyclones) ? archive.cyclones : [],
    wildfires: Array.isArray(archive.wildfires) ? archive.wildfires : [],
    forecasts: Array.isArray(archive.forecasts) ? archive.forecasts : []
  };
}

function writeArchive(archive) {
  store.set(DATA_ARCHIVE_KEY, archive);
}

function appendArchive(type, items) {
  if (!Array.isArray(items) || !items.length) return;
  const archive = readArchive();
  const stamped = items.map((item) => ({
    receivedAt: new Date().toISOString(),
    payload: item
  }));
  if (type === 'noaa') archive.noaa.push(...stamped);
  // USGS list is sorted newest-first per refresh; keep one snapshot (avoids huge store + wrong slice(-N) tails).
  if (type === 'usgs') archive.usgs = stamped;
  if (type === 'canada') archive.canada.push(...stamped);
  if (type === 'tsunamis') archive.tsunamis.push(...stamped);
  if (type === 'noaaDashboard') archive.noaaDashboard.push(...stamped);
  if (type === 'cyclones') archive.cyclones.push(...stamped);
  if (type === 'wildfires') archive.wildfires.push(...stamped);
  if (type === 'forecasts') archive.forecasts.push(...stamped);
  writeArchive(archive);
}

function resolveAppIconPath() {
  // electron-builder `build.files` historically omitted `assets/`; window + taskbar then fell back to defaults.
  // Prefer unpacked copy beside app.asar (extraResources) — Windows resolves this reliably for BrowserWindow icons.
  const fromExtraResources = path.join(process.resourcesPath || '', 'app-icon.ico');
  if (fromExtraResources && fs.existsSync(fromExtraResources)) return path.resolve(fromExtraResources);
  try {
    const inPackage = path.join(app.getAppPath(), 'assets', 'favicon.ico');
    if (fs.existsSync(inPackage)) return path.resolve(inPackage);
  } catch {
    /* app may not be ready in unusual load orders */
  }
  const devRelative = path.join(__dirname, '..', 'assets', 'favicon.ico');
  if (fs.existsSync(devRelative)) return path.resolve(devRelative);
  return undefined;
}

/** Prefer NativeImage on Windows so the shell gets a valid bitmap; string paths can still show the generic Electron icon. */
function resolveWindowIcon() {
  const iconPath = resolveAppIconPath();
  if (!iconPath) return undefined;
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img && !img.isEmpty()) return img;
  } catch {
    /* fall through */
  }
  return iconPath;
}

/**
 * Windows taskbar / shell use App User Model props, not only BrowserWindow `icon` (which drives title-bar chrome).
 * @see https://www.electronjs.org/docs/latest/api/browser-window#winsetappdetailsoptions-windows
 */
function applyWindowsTaskbarAppDetails(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const ico = resolveAppIconPath();
  if (!ico) return;
  try {
    win.setAppDetails({
      appId: WIN_APP_USER_MODEL_ID,
      appIconPath: path.resolve(ico),
      appIconIndex: 0
    });
  } catch (e) {
    console.warn(
      'Root Record Weather Manager: setAppDetails (taskbar icon):',
      e && e.message ? e.message : e
    );
  }
}

function createOrShowCriticalPopup(payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const lines = Array.isArray(safePayload.lines) ? safePayload.lines : [];
  const title = String(safePayload.title || 'Critical Alert');
  const message = lines.join('\n');

  if (alertWindow && !alertWindow.isDestroyed()) {
    alertWindow.webContents.send('critical-popup-data', { title, message });
    alertWindow.show();
    alertWindow.focus();
    return;
  }

  const alertIcon = resolveWindowIcon();
  alertWindow = new BrowserWindow({
    width: 560,
    height: 340,
    alwaysOnTop: true,
    skipTaskbar: false,
    frame: true,
    title: 'Root Record Critical Alert',
    ...(alertIcon ? { icon: alertIcon } : {}),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: false
    }
  });
  applyWindowsTaskbarAppDetails(alertWindow);
  alertWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  alertWindow.setAlwaysOnTop(true, 'screen-saver');
  alertWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Critical Alert</title>
      <style>
        body { margin: 0; padding: 14px; background: #200000; color: #ffdede; font-family: 'Segoe UI', sans-serif; }
        h2 { margin: 0 0 10px 0; color: #ff8a8a; }
        #msg { white-space: pre-wrap; background: #2b0d0d; border: 1px solid #5a1d1d; padding: 10px; border-radius: 4px; height: 220px; overflow-y: auto; }
        button { margin-top: 10px; padding: 8px 12px; background: #b71c1c; color: white; border: none; border-radius: 4px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h2 id="title">Critical Alert</h2>
      <div id="msg"></div>
      <button onclick="window.close()">Dismiss</button>
      <script>
        const { ipcRenderer } = require('electron');
        function update(data) {
          document.getElementById('title').textContent = data.title || 'Critical Alert';
          document.getElementById('msg').textContent = data.message || '';
        }
        ipcRenderer.on('critical-popup-data', (_e, data) => update(data || {}));
        update(${JSON.stringify({ title, message })});
      </script>
    </body>
    </html>
  `));
  alertWindow.show();
  alertWindow.focus();
  alertWindow.on('closed', () => {
    alertWindow = null;
  });
}

function createWindow() {
  const iconPath = resolveWindowIcon();
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      devTools: process.argv.includes('--dev')
    },
    title: 'Root Record Weather Manager'
  });
  applyWindowsTaskbarAppDetails(mainWindow);
  mainWindow.once('ready-to-show', () => applyWindowsTaskbarAppDetails(mainWindow));
  mainWindow.setMenu(null);

  const appHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Root Record Weather Manager</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          margin: 0;
          padding: 20px;
          background: #1e1e1e;
          color: #d4d4d4;
        }
        .auth-gate {
          position: fixed;
          inset: 0;
          z-index: 10000;
          background: #121212;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .auth-card {
          width: 100%;
          max-width: 520px;
          background: #252526;
          border-radius: 8px;
          border: 1px solid #333;
          padding: 18px;
        }
        .container {
          display: flex;
          flex-direction: column;
          height: calc(100vh - 40px);
          gap: 0;
          position: relative;
        }
        .nav-drawer-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 900;
          display: none;
        }
        .nav-drawer-backdrop.nav-backdrop-visible {
          display: block;
        }
        .nav-drawer {
          position: fixed;
          top: 0;
          left: 0;
          width: min(300px, 88vw);
          height: 100vh;
          background: #252526;
          border-right: 1px solid #3c3c3c;
          z-index: 910;
          padding: 16px 14px 24px 14px;
          overflow-y: auto;
          box-shadow: 6px 0 28px rgba(0, 0, 0, 0.35);
          transform: translateX(-100%);
          transition: transform 0.22s ease;
        }
        .nav-drawer.nav-drawer-open {
          transform: translateX(0);
        }
        .nav-drawer .btn {
          width: 100%;
          text-align: center;
        }
        .main-wrap {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          background: #252526;
          border-radius: 6px;
          overflow: hidden;
        }
        .guest-mode-banner {
          flex-shrink: 0;
          background: #8b1a1a;
          color: #fff5f5;
          padding: 10px 16px;
          font-size: 0.9rem;
          line-height: 1.45;
          text-align: center;
          border-bottom: 1px solid #5c1212;
        }
        .guest-mode-banner strong {
          color: #fff;
        }
        .app-top-bar {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 14px;
          border-bottom: 1px solid #3c3c3c;
          background: #2a2a2d;
        }
        .app-top-title {
          font-size: 16px;
          font-weight: 600;
          color: #e8e8e8;
          letter-spacing: 0.02em;
        }
        .hamburger-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 42px;
          height: 42px;
          padding: 0;
          margin: 0;
          background: #3c3c3c;
          border: 1px solid #555;
          border-radius: 6px;
          cursor: pointer;
          color: #e8e8e8;
        }
        .hamburger-btn:hover {
          background: #4a4a4a;
        }
        .hamburger-icon {
          font-size: 20px;
          line-height: 1;
        }
        .main {
          flex: 1;
          min-height: 0;
          padding: 16px;
          overflow-y: auto;
        }
        .btn {
          background: #007acc;
          color: white;
          border: none;
          padding: 8px 14px;
          margin: 4px 0;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn:hover { background: #005f9d; }
        .btn:disabled {
          background: #5a5a5a;
          cursor: not-allowed;
        }
        .btn.success { background: #2e7d32; }
        .btn.success:hover { background: #256628; }
        .btn.danger { background: #b71c1c; }
        .btn.danger:hover { background: #8e1616; }
        .card {
          background: #2d2d30;
          border-left: 3px solid #007acc;
          border-radius: 4px;
          padding: 10px;
          margin-bottom: 10px;
        }
        .dashboard-grid .card {
          margin-bottom: 0;
        }
        .clickable-card {
          cursor: pointer;
          transition: background 0.15s ease, transform 0.08s ease;
        }
        .clickable-card:hover {
          background: #34343a;
        }
        .clickable-card:active {
          transform: translateY(1px);
        }
        .status {
          padding: 10px;
          border-radius: 4px;
          margin: 8px 0 14px 0;
          font-size: 13px;
        }
        .status.ok { background: #1b5e20; }
        .status.warn { background: #8a6d1b; }
        .status.error { background: #7f1d1d; color: #f5f5f5; }
        .row { margin-bottom: 10px; }
        label { display: block; font-size: 12px; color: #b8b8b8; margin-bottom: 4px; }
        input {
          width: calc(100% - 16px);
          padding: 8px;
          border: 1px solid #555;
          border-radius: 4px;
          background: #1e1e1e;
          color: #d4d4d4;
        }
        .location-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 8px;
          margin-bottom: 6px;
          background: #1e1e1e;
          border-radius: 4px;
        }
        .muted { color: #9a9a9a; font-size: 12px; }
        .section-title { color: #4ec9b0; margin-top: 0; }
        .result-group { margin-bottom: 22px; }
        .earthquakes-page-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          align-items: start;
          margin-top: 8px;
        }
        .earthquakes-page-grid .result-group {
          margin-bottom: 0;
        }
        @media (max-width: 960px) {
          .earthquakes-page-grid {
            grid-template-columns: 1fr;
          }
        }
        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 8px;
          margin: 10px 0 14px 0;
        }
        .dashboard-grid.dashboard-grid-weather-summary {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        @media (max-width: 1020px) {
          .dashboard-grid.dashboard-grid-weather-summary {
            grid-template-columns: 1fr;
          }
        }
        .dashboard-card-span-full {
          grid-column: 1 / -1;
        }
        .weather-satellite-strip {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          align-items: start;
        }
        @media (max-width: 720px) {
          .weather-satellite-strip {
            grid-template-columns: 1fr;
          }
        }
        .weather-satellite-cell strong {
          display: block;
          margin-bottom: 4px;
        }
        .weather-satellite-cell img {
          width: 100%;
          max-height: 240px;
          object-fit: contain;
          border: 1px solid #333;
          border-radius: 4px;
          background: #111;
        }
        .map-modal {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          z-index: 1200;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .map-card {
          width: min(900px, 96vw);
          height: min(680px, 92vh);
          background: #252526;
          border-radius: 8px;
          border: 1px solid #333;
          padding: 12px;
          display: flex;
          flex-direction: column;
        }
        #locationMap {
          flex: 1;
          border: 1px solid #333;
          border-radius: 6px;
          min-height: 360px;
          background: #111;
        }
        .detail-modal {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          z-index: 1201;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .detail-card {
          width: min(820px, 96vw);
          max-height: min(680px, 92vh);
          overflow: auto;
          background: #252526;
          border-radius: 8px;
          border: 1px solid #333;
          padding: 12px;
        }
        pre {
          background: #161616;
          padding: 10px;
          border-radius: 4px;
          border: 1px solid #333;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
      </style>
    </head>
    <body>
      <div id="authGate" class="auth-gate" style="display:flex;">
        <div class="auth-card">
          <h1 style="margin-top:0;">Sign in to RootRecord</h1>
          <p class="muted">Sign in to an existing account, or use <strong>Create account</strong> to register on this device.</p>
          <div class="row">
            <label for="authEmail">Email</label>
            <input id="authEmail" placeholder="you@example.com" />
          </div>
          <div class="row">
            <label for="authPassword">Password</label>
            <input id="authPassword" type="password" placeholder="At least 10 characters" />
          </div>
          <div class="row">
            <button type="button" id="authSignInBtn" class="btn success">Sign In</button>
            <button type="button" id="authSignUpBtn" class="btn">Create Account</button>
            <button type="button" id="authSubscribeBtn" class="btn warning">Subscribe</button>
            <button type="button" id="authOpenWebsiteBtn" class="btn">Open RootRecord.com</button>
          </div>
          <p class="muted" style="font-size:0.88rem;margin:14px 0 0;line-height:1.45;">You can continue <strong>without signing in</strong> for local-only use. This sign-in screen appears every time you open the app until you sign in.</p>
          <div class="row" style="margin-top:10px;">
            <button type="button" id="authContinueLocalBtn" class="btn">Continue without signing in</button>
          </div>
          <div id="authStatus" class="status" role="status" aria-live="polite" style="display:none;"></div>
        </div>
      </div>

      <div id="appShell" class="container" style="display:none;">
        <div id="navDrawerBackdrop" class="nav-drawer-backdrop" onclick="closeNavDrawer()" aria-hidden="true"></div>
        <aside id="navDrawer" class="nav-drawer" aria-label="Navigation">
          <h2 class="section-title">Resources</h2>
          <button type="button" class="btn" onclick="showPage('weather')">Weather</button>
          <button type="button" class="btn" onclick="showPage('earthquakes')">Earthquakes & Tsunamis</button>
          <button type="button" class="btn" onclick="showPage('cyclones')">Cyclone Tracker</button>
          <button type="button" class="btn" onclick="showPage('wildfires')">Wildfires</button>
          <button type="button" class="btn" onclick="showPage('settings')">Settings</button>
          <button type="button" class="btn" onclick="showPage('about')">About / Coverage</button>
          <button type="button" class="btn" onclick="showPage('contact')">Contact & Feedback</button>
        </aside>

        <div class="main-wrap">
          <div id="guestModeBanner" class="guest-mode-banner" role="alert" style="display:none;">
            <strong>Not signed in.</strong>
            You are in a restricted local session — Root Record cloud sync and backup are off, Pro-only options stay locked, and live public data refresh is throttled. Sign in from <strong>Settings</strong> when you want full access.
          </div>
          <header class="app-top-bar">
            <button type="button" id="navHamburgerBtn" class="hamburger-btn" onclick="toggleNavDrawer()" aria-label="Open navigation menu" aria-expanded="false" aria-controls="navDrawer">
              <span class="hamburger-icon" aria-hidden="true">&#9776;</span>
            </button>
            <span class="app-top-title">Root Record Weather Manager</span>
          </header>
        <main class="main">
          <div id="weather-page" class="page">
            <h1>Weather</h1>
            <p class="muted">Dashboard, active alerts, and future forecast periods for your saved locations.</p>
            <div class="dashboard-grid dashboard-grid-weather-summary">
              <div class="card clickable-card" onclick="openDashboardDetail('weatherCurrentCard','Current Conditions')">
                <h3 style="margin-top:0;">Current Conditions</h3>
                <div id="weatherCurrentCard" class="muted">No current condition data yet.</div>
              </div>
              <div class="card clickable-card" onclick="openDashboardDetail('weatherDailyCard','Daily Forecast')">
                <h3 style="margin-top:0;">Daily Forecast</h3>
                <div id="weatherDailyCard" class="muted">No daily forecast data yet.</div>
              </div>
              <div class="card clickable-card" onclick="openDashboardDetail('weatherAveragesCard','24h Averages')">
                <h3 style="margin-top:0;">24h Averages</h3>
                <div id="weatherAveragesCard" class="muted">No 24-hour average data yet.</div>
              </div>
            </div>
            <div class="dashboard-grid">
              <div class="card clickable-card dashboard-card-span-full" onclick="openDashboardDetail('weatherRadarCard','Radar layers')">
                <h3 style="margin-top:0;">Radar layers</h3>
                <div id="weatherRadarCard" class="muted">No radar layer assets yet.</div>
              </div>
              <div class="card clickable-card dashboard-card-span-full" onclick="openDashboardDetail('weatherSatelliteCard','Satellite imagery')">
                <h3 style="margin-top:0;">Satellite imagery</h3>
                <div id="weatherSatelliteCard" class="muted">No satellite layer assets yet.</div>
              </div>
            </div>
            <div class="result-group">
              <h2>Weather alerts</h2>
              <div id="noaaResults"></div>
            </div>
            <div id="canadaAlertsSection" class="result-group" style="display:none;">
              <h2>Canada weather alerts</h2>
              <div id="canadaResults"></div>
            </div>
            <div class="result-group">
              <h2>Future forecast periods</h2>
              <p class="muted" style="margin-top:0;margin-bottom:12px;">Grid forecast periods that start after the current time, for each configured location.</p>
              <div id="forecastResults"></div>
            </div>
          </div>

          <div id="earthquakes-page" class="page" style="display:none;">
            <h1>Earthquakes & Tsunamis</h1>
            <p class="muted">USGS earthquakes (last 30 days, newest first) plus tsunami warning center bulletins.</p>
            <div class="earthquakes-page-grid">
              <div class="result-group">
                <h2>USGS Earthquakes</h2>
                <div id="usgsResults"></div>
              </div>
              <div class="result-group">
                <h2>Tsunami Bulletins</h2>
                <div id="tsunamiResults"></div>
              </div>
            </div>
          </div>

          <div id="cyclones-page" class="page" style="display:none;">
            <h1>Cyclone Tracker</h1>
            <p class="muted">Live cyclone events from public event feeds.</p>
            <div class="result-group">
              <h2>Active Cyclone Events</h2>
              <div id="cycloneResults"></div>
            </div>
          </div>

          <div id="wildfires-page" class="page" style="display:none;">
            <h1>Wildfires</h1>
            <p class="muted">Global wildfire events from public event feeds.</p>
            <div class="result-group">
              <h2>Active Wildfire Events</h2>
              <div id="wildfireResults"></div>
            </div>
          </div>

          <div id="settings-page" class="page" style="display:none;">
            <h1>Settings</h1>
            <p id="settingsPlanSummary" class="muted" style="margin:4px 0 12px 0;"></p>
            <div class="card" style="margin-bottom:16px;">
              <h3 style="margin-top:0;">Data feeds</h3>
              <p id="dataLastUpdatedLabel" class="muted" style="margin:0 0 10px 0;">Last updated: —</p>
              <p class="muted" style="font-size:13px;margin:0 0 12px 0;line-height:1.45;">Updates the weather dashboard, alerts, earthquakes, tsunami bulletins, cyclone and wildfire feeds, and location forecasts. Scheduled background refresh still runs automatically.</p>
              <button type="button" id="settingsRefreshAllBtn" class="btn" onclick="refreshAllDataFromSettings()">Refresh all data</button>
            </div>
            <div id="setupStatus" class="status error" style="display:none;" aria-live="polite"></div>
            <div class="row">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input id="openAtLoginToggle" type="checkbox" style="width:20px;height:20px;" onchange="toggleOpenAtLogin()" />
                <span>Start Root Record Weather Manager when Windows signs in</span>
              </label>
            </div>
            <h3>Root Record account</h3>
            <p class="muted">Session is stored in <code>license_session.json</code> in this app’s data folder (Business Manager uses the same format).</p>
            <button type="button" class="btn danger" onclick="authLogout()">Sign out of this device</button>
            <div class="row">
              <label for="unitSystem">Units</label>
              <select id="unitSystem" onchange="onUnitSystemChanged()" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#d4d4d4;">
                <option value="imperial">Imperial (F, mph, mi)</option>
                <option value="metric">Metric (C, km/h, km)</option>
              </select>
            </div>
            <div class="row">
              <label for="radiusMiles">Pull Radius (miles)</label>
              <input id="radiusMiles" placeholder="e.g. 150" />
            </div>
            <h3>Critical Popup Alerts</h3>
            <p id="criticalAlertsProNote" class="muted" style="display:none;margin:4px 0 12px 0;line-height:1.45;"></p>
            <div class="row">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input id="weatherCriticalToggle" type="checkbox" style="width:20px;height:20px;" />
                <span>Enable weather critical popups (United States + Canada sources)</span>
              </label>
            </div>
            <div class="row">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input id="usgsCriticalToggle" type="checkbox" style="width:20px;height:20px;" />
                <span>Enable USGS earthquake critical popups</span>
              </label>
            </div>
            <div class="row">
              <label for="usgsMinMagnitude">USGS popup minimum magnitude</label>
              <input id="usgsMinMagnitude" placeholder="e.g. 3.0" />
            </div>
            <div class="row">
              <label for="usgsPopupDistance">USGS popup max distance (miles)</label>
              <input id="usgsPopupDistance" placeholder="e.g. 200" />
            </div>
            <div class="row">
              <label for="alertSoundSelect">Critical alert sound</label>
              <select id="alertSoundSelect" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#d4d4d4;">
                <option value="">No custom sound</option>
              </select>
            </div>
            <button type="button" id="previewAlertSoundBtn" class="btn" onclick="previewSelectedAlertSound()">Test Selected Sound</button>
            <button type="button" id="saveAlertSettingsBtn" class="btn" onclick="saveAlertSettings()">Save Alert Settings</button>
            <div class="row">
              <label for="locationName">Location Name</label>
              <input id="locationName" placeholder="Home, Shop, Cabin..." />
            </div>
            <div class="row">
              <label for="locationLat">Latitude</label>
              <input id="locationLat" placeholder="e.g. 47.6062" />
            </div>
            <div class="row">
              <label for="locationLon">Longitude</label>
              <input id="locationLon" placeholder="e.g. -122.3321" />
            </div>
            <button class="btn" onclick="openLocationMapPicker()">Pick on Map</button>
            <button class="btn" onclick="addLocation()">Add Location</button>

            <h3>Configured Locations</h3>
            <div id="locationList"></div>
            <button class="btn success" onclick="completeSetup()">Finalize Setup</button>
            <div id="setupFinalizeConfirm" class="status ok" role="status" aria-live="polite" style="display:none;margin-top:10px;"></div>
            <p class="muted">Data calls are blocked until setup is finalized with at least one location.</p>

            <h3 style="margin-top:22px;">Database backups (local)</h3>
            <p class="muted">SQLite snapshots on this device only. Account data and app-side records are backed by RootRecord’s Cloudflare-backed services; this folder is for your own copies of the local database file.</p>
            <div class="row">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                <input id="autoBackupToggle" type="checkbox" style="width:20px;height:20px;" />
                <span>Automatic backups</span>
              </label>
            </div>
            <div class="row">
              <label for="autoBackupHours">Every (hours)</label>
              <input id="autoBackupHours" type="number" min="1" step="1" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#1e1e1e;color:#d4d4d4;" />
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
              <button type="button" class="btn" onclick="backupDatabaseNow()">Backup database now</button>
              <button type="button" class="btn" onclick="openBackupFolder()">Open backup folder</button>
              <button type="button" class="btn" onclick="saveBackupSettings()">Save backup settings</button>
            </div>

            <div class="result-group">
              <h3>Archive Totals</h3>
              <pre id="archiveSummary">Loading...</pre>
            </div>
          </div>
          <div id="about-page" class="page" style="display:none;">
            <h1>About / Data Coverage</h1>
            <p id="aboutPlanSummary" class="muted" style="margin:4px 0 16px 0;"></p>
            <div class="card">
              <h3>Commercial-use data sources included</h3>
              <p><strong>United States weather:</strong> Federally published alerts (watches, warnings, advisories).</p>
              <p><strong>Canada weather:</strong> Federally published Canadian alerts where licensing allows redistribution.</p>
              <p><strong>USGS:</strong> Global earthquake data (last 30 days; includes Asia, Australia, Europe, Africa, and Americas).</p>
              <p><strong>Tsunami bulletins:</strong> Public tsunami warning center products.</p>
              <p><strong>NASA EONET:</strong> Public global event feeds used for cyclone and wildfire tracking pages.</p>
              <p><strong>Grid forecasts:</strong> Location-based future forecast periods on the Weather page.</p>
            </div>
            <div class="card">
              <h3>Regional coverage summary</h3>
              <p><strong>United States:</strong> Weather alerts + earthquakes.</p>
              <p><strong>Canada:</strong> Weather alerts + earthquakes.</p>
              <p><strong>Asia / Australia / Europe / Africa / South America:</strong> Earthquake data now; weather alerts added only when clear free commercial licensing is confirmed.</p>
            </div>
            <div class="card">
              <h3>Why some weather providers are not included yet</h3>
              <p>Some regional weather APIs require paid commercial plans or separate written licensing agreements. This app only includes sources with clearly documented free commercial reuse rights.</p>
            </div>
            <div class="card">
              <h3>Polling cadence</h3>
              <p><strong>USGS (Earthquakes & Tsunamis page):</strong> scheduled every 5 minutes for near-real-time updates.</p>
              <p><strong>All other API sources:</strong> scheduled every 30 minutes.</p>
            </div>
            <div class="card">
              <h3>Software updates</h3>
              <p class="muted" style="margin-top:0;line-height:1.45;">The Windows installer checks <strong>GitHub Releases</strong> for a newer version (same pattern as RootRecord Business Manager). You get a prompt to download; after download, another prompt to restart and finish installing.</p>
              <button type="button" class="btn" onclick="checkForUpdatesFromAbout()">Check for updates…</button>
            </div>
          </div>
          <div id="contact-page" class="page" style="display:none;">
            <h1>Contact & Feedback</h1>
            <div class="card">
              <h3>Official Root Record links</h3>
              <p><strong>Website:</strong> <a href="#" onclick="openRootRecordWebsite()">https://rootrecord.com</a></p>
              <p><strong>Support email:</strong> <a href="#" onclick="emailRootRecordSupport()">root@rootrecord.info</a></p>
              <p><strong>Discord (community support):</strong> <a href="#" onclick="openDiscordSupport()">https://discord.gg/CPaDYuFkU</a></p>
            </div>
            <div class="card">
              <h3>Send feedback</h3>
              <p>Use email or Discord for bug reports, feature requests, and general feedback about Root Record Weather Manager.</p>
              <button class="btn" onclick="emailRootRecordSupport()">Email support</button>
              <button class="btn" onclick="openDiscordSupport()">Open Discord</button>
              <button class="btn" onclick="openRootRecordWebsite()">Open RootRecord.com</button>
            </div>
          </div>
        </main>
        </div>
      </div>
      <div id="mapModal" class="map-modal">
        <div class="map-card">
          <h3 style="margin:0 0 8px 0;">Select Location on Map</h3>
          <p class="muted" style="margin:0 0 8px 0;">Click anywhere to place the marker, then apply coordinates.</p>
          <div id="locationMap"></div>
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;">
            <span id="mapCoordLabel" class="muted">No point selected.</span>
            <div>
              <button class="btn" onclick="applyPickedLocation()">Use Selected Point</button>
              <button class="btn danger" onclick="closeLocationMapPicker()">Cancel</button>
            </div>
          </div>
        </div>
      </div>
      <div id="dashboardDetailModal" class="detail-modal" onclick="closeDashboardDetail(event)">
        <div class="detail-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
            <h3 id="dashboardDetailTitle" style="margin:0;">Dashboard Detail</h3>
            <button class="btn danger" onclick="closeDashboardDetail()">Close</button>
          </div>
          <div id="dashboardDetailBody" class="muted">No details loaded yet.</div>
        </div>
      </div>

      <script>
        let ipcRenderer;
        try {
          ({ ipcRenderer } = require('electron'));
        } catch (_error) {
          const bridge = typeof window !== 'undefined' && window.rootRecordBridge ? window.rootRecordBridge : null;
          if (bridge && typeof bridge.invoke === 'function') {
            ipcRenderer = { invoke: (channel, payload) => bridge.invoke(channel, payload) };
          } else {
            ipcRenderer = {
              invoke: async () => {
                throw new Error('IPC bridge unavailable. Please reinstall the latest build.');
              }
            };
            setTimeout(() => {
              const statusEl = document.getElementById('authStatus');
              if (statusEl) {
                statusEl.style.display = '';
                statusEl.className = 'status error';
                statusEl.textContent = 'App runtime not fully initialized. Please reinstall/update this build.';
              }
            }, 0);
          }
        }
        let config = {
          isConfigured: false,
          radiusMiles: 150,
          unitSystem: 'imperial',
          criticalAlerts: {
            weatherEnabled: true,
            usgsEnabled: true,
            usgsMinMagnitude: 5.0,
            usgsMaxDistanceMiles: 200,
            soundPath: ''
          },
          locations: []
        };
        let mapPickerReady = false;
        let mapPicker;
        let mapMarker;
        let pickedLatLon = null;
        let usgsDetailMap = null;
        let usgsDetailMapRequestId = 0;
        let setupFinalizeConfirmTimer = null;
        let availableAlertSounds = [];
        let licenseProUnlocked = false;
        /** True when using the app without a Root Record account (live API refresh is throttled in main). */
        let guestLiveDataCapped = false;

        async function notifyGuestLiveRefreshCycleComplete() {
          try {
            await ipcRenderer.invoke('weather-guest-live-refresh-cycle-complete');
          } catch (_) {
            /* ignore */
          }
        }

        let guestLiveBundleDepth = 0;
        async function withGuestLiveBundle(inner) {
          guestLiveBundleDepth += 1;
          try {
            return await inner();
          } finally {
            guestLiveBundleDepth -= 1;
            if (guestLiveBundleDepth <= 0) {
              guestLiveBundleDepth = 0;
              void notifyGuestLiveRefreshCycleComplete();
            }
          }
        }

        const detailItems = {
          noaa: [],
          canada: [],
          usgs: [],
          tsunamis: [],
          cyclones: [],
          wildfires: [],
          forecasts: []
        };

        function escapeHtml(value) {
          return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        }

        const LAST_DATA_REFRESH_KEY = 'rrwm_last_data_refresh';

        function touchDataLastUpdated() {
          const el = document.getElementById('dataLastUpdatedLabel');
          const d = new Date();
          const text = 'Last updated: ' + d.toLocaleString();
          if (el) el.textContent = text;
          try {
            localStorage.setItem(LAST_DATA_REFRESH_KEY, d.toISOString());
          } catch (e) {
            /* ignore */
          }
        }

        function restoreDataLastUpdatedLabel() {
          const el = document.getElementById('dataLastUpdatedLabel');
          if (!el) return;
          let iso = null;
          try {
            iso = localStorage.getItem(LAST_DATA_REFRESH_KEY);
          } catch (e) {
            iso = null;
          }
          if (iso) {
            const d = new Date(iso);
            if (!Number.isNaN(d.getTime())) {
              el.textContent = 'Last updated: ' + d.toLocaleString();
              return;
            }
          }
          el.textContent = 'Last updated: —';
        }

        /**
         * Inline HTML onclick=... is unreliable for file:// loads in Electron (sidebar may still
         * work via the did-finish-load fallback). Re-bind as real listeners using the same code.
         */
        function wireHtmlOnclickAttributes(root) {
          const rootEl = root && root.nodeType ? root : document;
          if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
          const nodes = rootEl.querySelectorAll('[onclick]');
          for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            if (el.dataset && el.dataset.rrOnclickWired === '1') continue;
            const ocRaw = el.getAttribute('onclick');
            if (!ocRaw) continue;
            const oc = String(ocRaw).trim();
            if (!oc) continue;
            if (el.dataset) el.dataset.rrOnclickWired = '1';
            el.removeAttribute('onclick');
            let runner;
            try {
              runner = new Function('event', oc);
            } catch (e) {
              console.error('[RootRecord Weather Manager] Invalid onclick:', oc, e);
              continue;
            }
            const tag = String(el.tagName || '').toLowerCase();
            el.addEventListener('click', function (event) {
              if (tag === 'a') event.preventDefault();
              try {
                runner.call(window, event);
              } catch (err) {
                console.error('[RootRecord Weather Manager] Action failed:', oc, err);
              }
            });
          }
        }

        function toNumber(value) {
          const n = Number(value);
          return Number.isFinite(n) ? n : null;
        }

        function getUnitSystem() {
          return config && config.unitSystem === 'metric' ? 'metric' : 'imperial';
        }

        function applyCriticalAlertsProLock() {
          const locked = !licenseProUnlocked;
          const ids = [
            'weatherCriticalToggle',
            'usgsCriticalToggle',
            'usgsMinMagnitude',
            'usgsPopupDistance',
            'alertSoundSelect',
            'previewAlertSoundBtn',
            'saveAlertSettingsBtn'
          ];
          for (let i = 0; i < ids.length; i += 1) {
            const el = document.getElementById(ids[i]);
            if (el) el.disabled = locked;
          }
          const note = document.getElementById('criticalAlertsProNote');
          if (note) {
            if (!locked) {
              note.style.display = 'none';
              note.textContent = '';
            } else {
              note.style.display = '';
              note.textContent =
                'Critical popups and custom alert sounds are included with Pro. Preferences stay on file for when you upgrade; use RootRecord.com to subscribe.';
            }
          }
        }

        function getAlertPrefs() {
          const prefs = config && config.criticalAlerts && typeof config.criticalAlerts === 'object' ? config.criticalAlerts : {};
          const minMagnitude = Number(prefs.usgsMinMagnitude);
          const maxDistanceMiles = Number(prefs.usgsMaxDistanceMiles);
          return {
            weatherEnabled: prefs.weatherEnabled !== false,
            usgsEnabled: prefs.usgsEnabled !== false,
            usgsMinMagnitude: Number.isFinite(minMagnitude) ? Math.max(0, minMagnitude) : 5.0,
            usgsMaxDistanceMiles: Number.isFinite(maxDistanceMiles) && maxDistanceMiles > 0 ? maxDistanceMiles : 200,
            soundPath: String(prefs.soundPath || '').trim()
          };
        }

        function fileUrlFromPath(filePath) {
          return encodeURI('file:///' + String(filePath || '').replace(/\\\\/g, '/'));
        }

        async function loadAlertSounds() {
          const select = document.getElementById('alertSoundSelect');
          if (!select) return;
          availableAlertSounds = await ipcRenderer.invoke('get-alert-sounds');
          const options = ['<option value="">No custom sound</option>'];
          for (const sound of availableAlertSounds) {
            options.push('<option value="' + escapeHtml(sound.path) + '">' + escapeHtml(sound.name) + '</option>');
          }
          select.innerHTML = options.join('');
        }

        function storedMilesToUiRadius(miles) {
          const n = Number(miles);
          if (!Number.isFinite(n)) return 150;
          return getUnitSystem() === 'metric' ? n * 1.60934 : n;
        }

        function uiRadiusToStoredMiles(uiRadius) {
          const n = Number(uiRadius);
          if (!Number.isFinite(n)) return 150;
          return getUnitSystem() === 'metric' ? (n / 1.60934) : n;
        }

        function applyRadiusLabelAndValue() {
          const label = document.querySelector('label[for="radiusMiles"]');
          if (label) {
            label.textContent = getUnitSystem() === 'metric' ? 'Pull Radius (km)' : 'Pull Radius (miles)';
          }
          const field = document.getElementById('radiusMiles');
          if (field) field.value = String(storedMilesToUiRadius(config.radiusMiles).toFixed(1).replace(/\.0$/, ''));
          const distLabel = document.querySelector('label[for="usgsPopupDistance"]');
          if (distLabel) distLabel.textContent = getUnitSystem() === 'metric' ? 'USGS popup max distance (km)' : 'USGS popup max distance (miles)';
          const distInput = document.getElementById('usgsPopupDistance');
          if (distInput) distInput.value = String(storedMilesToUiRadius(getAlertPrefs().usgsMaxDistanceMiles).toFixed(1).replace(/\.0$/, ''));
        }

        function applyAlertSettingsFields() {
          const prefs = getAlertPrefs();
          const weatherToggle = document.getElementById('weatherCriticalToggle');
          const usgsToggle = document.getElementById('usgsCriticalToggle');
          const minMagnitude = document.getElementById('usgsMinMagnitude');
          const soundSelect = document.getElementById('alertSoundSelect');
          if (weatherToggle) weatherToggle.checked = Boolean(prefs.weatherEnabled);
          if (usgsToggle) usgsToggle.checked = Boolean(prefs.usgsEnabled);
          if (minMagnitude) minMagnitude.value = String(prefs.usgsMinMagnitude);
          if (soundSelect) soundSelect.value = prefs.soundPath || '';
        }

        function playAlertSound(soundPath) {
          const chosenPath = String(soundPath || '').trim();
          if (!chosenPath) return;
          try {
            const audio = new Audio(fileUrlFromPath(chosenPath));
            audio.volume = 1.0;
            void audio.play();
          } catch {
            // Ignore sound playback errors.
          }
        }

        function previewSelectedAlertSound() {
          if (!licenseProUnlocked) {
            alert('Custom alert sounds are included with Pro. Subscribe on RootRecord.com to use this.');
            return;
          }
          const select = document.getElementById('alertSoundSelect');
          if (!select) return;
          playAlertSound(select.value);
        }

        async function saveAlertSettings() {
          if (!licenseProUnlocked) {
            alert('Critical popups and custom sounds are included with Pro. Subscribe on RootRecord.com to change these settings.');
            return;
          }
          const weatherToggle = document.getElementById('weatherCriticalToggle');
          const usgsToggle = document.getElementById('usgsCriticalToggle');
          const minMagnitudeRaw = toNumber((document.getElementById('usgsMinMagnitude') || {}).value || '');
          const distanceUiRaw = toNumber((document.getElementById('usgsPopupDistance') || {}).value || '');
          const soundSelect = document.getElementById('alertSoundSelect');
          const prefs = getAlertPrefs();
          const next = {
            weatherEnabled: weatherToggle ? Boolean(weatherToggle.checked) : prefs.weatherEnabled,
            usgsEnabled: usgsToggle ? Boolean(usgsToggle.checked) : prefs.usgsEnabled,
            usgsMinMagnitude: minMagnitudeRaw === null || minMagnitudeRaw < 0 ? 5.0 : minMagnitudeRaw,
            usgsMaxDistanceMiles: distanceUiRaw === null || distanceUiRaw <= 0 ? 200 : uiRadiusToStoredMiles(distanceUiRaw),
            soundPath: soundSelect ? String(soundSelect.value || '').trim() : prefs.soundPath
          };
          config.criticalAlerts = next;
          config = await ipcRenderer.invoke('save-location-config', config);
          applyAlertSettingsFields();
          applyRadiusLabelAndValue();
        }

        function formatDistanceFromMiles(miles) {
          const n = Number(miles);
          if (!Number.isFinite(n)) return 'n/a';
          if (getUnitSystem() === 'metric') return (n * 1.60934).toFixed(1) + ' km';
          return n.toFixed(1) + ' mi';
        }

        function formatTemperatureF(value) {
          const n = Number(value);
          if (!Number.isFinite(n)) return 'n/a';
          if (getUnitSystem() === 'metric') return (((n - 32) * 5) / 9).toFixed(1) + ' C';
          return n.toFixed(1) + ' F';
        }

        function formatWindMph(value) {
          const raw = String(value || '').trim();
          const first = Number(raw.split(' ')[0]);
          if (Number.isFinite(first)) {
            if (getUnitSystem() === 'metric') return (first * 1.60934).toFixed(1) + ' km/h';
            return first.toFixed(1) + ' mph';
          }
          return raw || 'n/a';
        }

        function normalizeForecastTemp(temp, unit) {
          const n = Number(temp);
          const u = String(unit || '').toUpperCase();
          if (!Number.isFinite(n)) return 'n/a';
          if (getUnitSystem() === 'imperial') {
            if (u === 'C') return ((n * 9) / 5 + 32).toFixed(1) + ' F';
            return n.toFixed(1) + ' F';
          }
          if (u === 'F') return (((n - 32) * 5) / 9).toFixed(1) + ' C';
          return n.toFixed(1) + ' C';
        }

        function destroyUsgsDetailMap() {
          if (usgsDetailMap) {
            try {
              usgsDetailMap.remove();
            } catch {
              /* ignore */
            }
            usgsDetailMap = null;
          }
        }

        function mountUsgsEventDetailMap(lat, lon) {
          const host = document.getElementById('usgsEventDetailMapHost');
          if (!host || !window.L || !host.isConnected) return;
          destroyUsgsDetailMap();
          usgsDetailMap = window.L.map(host, { zoomControl: true, attributionControl: true }).setView([lat, lon], 9);
          window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 18,
            attribution: 'Tiles &copy; Esri'
          }).addTo(usgsDetailMap);
          window.L.marker([lat, lon]).addTo(usgsDetailMap);
          setTimeout(() => {
            if (usgsDetailMap) usgsDetailMap.invalidateSize();
          }, 80);
          setTimeout(() => {
            if (usgsDetailMap) usgsDetailMap.invalidateSize();
          }, 400);
        }

        function ensureLeafletLoaded() {
          return new Promise((resolve, reject) => {
            if (window.L) return resolve();
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(css);
            const js = document.createElement('script');
            js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            js.onload = () => resolve();
            js.onerror = () => reject(new Error('Failed to load map library.'));
            document.head.appendChild(js);
          });
        }

        function setMapCoordLabel(text) {
          const el = document.getElementById('mapCoordLabel');
          if (el) el.textContent = text;
        }

        function setPickedLocation(lat, lon) {
          pickedLatLon = { lat, lon };
          setMapCoordLabel('Selected: ' + lat.toFixed(6) + ', ' + lon.toFixed(6));
          if (mapMarker) {
            mapMarker.setLatLng([lat, lon]);
          } else {
            mapMarker = window.L.marker([lat, lon]).addTo(mapPicker);
          }
        }

        async function openLocationMapPicker() {
          try {
            await ensureLeafletLoaded();
            const modal = document.getElementById('mapModal');
            if (modal) modal.style.display = 'flex';
            const latInput = toNumber((document.getElementById('locationLat') || {}).value || '');
            const lonInput = toNumber((document.getElementById('locationLon') || {}).value || '');
            const startLat = latInput !== null ? latInput : 39.8283;
            const startLon = lonInput !== null ? lonInput : -98.5795;
            if (!mapPickerReady) {
              mapPicker = window.L.map('locationMap').setView([startLat, startLon], latInput !== null && lonInput !== null ? 9 : 4);
              // OSM tile servers can block packaged desktop requests without referrer headers.
              // Use Esri basemap tiles for a stable, no-auth map picker experience.
              window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 18,
                attribution: 'Tiles &copy; Esri'
              }).addTo(mapPicker);
              mapPicker.on('click', (evt) => {
                setPickedLocation(evt.latlng.lat, evt.latlng.lng);
              });
              mapPickerReady = true;
            } else {
              mapPicker.setView([startLat, startLon], latInput !== null && lonInput !== null ? 9 : 4);
            }
            if (latInput !== null && lonInput !== null) {
              setPickedLocation(latInput, lonInput);
            } else {
              pickedLatLon = null;
              if (mapMarker) {
                mapPicker.removeLayer(mapMarker);
                mapMarker = null;
              }
              setMapCoordLabel('No point selected.');
            }
            setTimeout(() => {
              if (mapPicker) mapPicker.invalidateSize();
            }, 20);
          } catch (error) {
            alert('Map picker unavailable: ' + error.message);
          }
        }

        function closeLocationMapPicker() {
          const modal = document.getElementById('mapModal');
          if (modal) modal.style.display = 'none';
        }

        function applyPickedLocation() {
          if (!pickedLatLon) {
            alert('Select a point on the map first.');
            return;
          }
          const latInput = document.getElementById('locationLat');
          const lonInput = document.getElementById('locationLon');
          if (latInput) latInput.value = pickedLatLon.lat.toFixed(6);
          if (lonInput) lonInput.value = pickedLatLon.lon.toFixed(6);
          closeLocationMapPicker();
        }

        function openDashboardDetail(sourceId, title) {
          usgsDetailMapRequestId += 1;
          destroyUsgsDetailMap();
          const modal = document.getElementById('dashboardDetailModal');
          const titleEl = document.getElementById('dashboardDetailTitle');
          const bodyEl = document.getElementById('dashboardDetailBody');
          const source = document.getElementById(sourceId);
          if (!modal || !titleEl || !bodyEl || !source) return;
          titleEl.textContent = String(title || 'Dashboard Detail');
          bodyEl.innerHTML = source.innerHTML || '<span class="muted">No detail available yet.</span>';
          modal.style.display = 'flex';
        }

        function closeDashboardDetail(event) {
          if (event && event.target && event.target.id !== 'dashboardDetailModal') return;
          usgsDetailMapRequestId += 1;
          destroyUsgsDetailMap();
          const modal = document.getElementById('dashboardDetailModal');
          if (modal) modal.style.display = 'none';
        }

        function openExternalUrl(url) {
          const cleanUrl = String(url || '').trim();
          if (!cleanUrl || !/^https?:\\/\\//i.test(cleanUrl)) return;
          void ipcRenderer.invoke('open-external-url', cleanUrl);
        }

        function cyclonesWebSearchUrl(item) {
          const title = item && item.title != null ? String(item.title).trim() : '';
          const q = title || 'tropical cyclone';
          return 'https://www.google.com/search?q=' + encodeURIComponent(q);
        }

        function wildfiresWebSearchUrl(item) {
          const title = item && item.title != null ? String(item.title).trim() : '';
          const q = title || 'wildland fire';
          return 'https://www.google.com/search?q=' + encodeURIComponent(q);
        }

        function detailLine(label, value) {
          const text = String(value == null ? '' : value).trim();
          if (!text) return '';
          return '<div style="margin-bottom:6px;"><span class="muted">' + escapeHtml(label) + ':</span> ' + escapeHtml(text) + '</div>';
        }

        function eventDetailHtml(type, item) {
          if (!item || typeof item !== 'object') return '<span class="muted">No detail available.</span>';
          const sourceUrl = String(item.detailUrl || item.url || item.source || '').trim();
          const lines = [];
          if (type === 'usgs') {
            const lat = Number(item.latitude);
            const lon = Number(item.longitude);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              lines.push(
                '<div id="usgsEventDetailMapHost" style="height:220px;width:100%;margin:0 0 12px 0;border-radius:6px;border:1px solid #444;overflow:hidden;background:#111;"></div>'
              );
              lines.push(detailLine('Epicenter', lat.toFixed(4) + ', ' + lon.toFixed(4)));
            }
            lines.push(detailLine('Magnitude', item.magnitude));
            lines.push(detailLine('Time', item.time));
            lines.push(detailLine('Distance', formatDistanceFromMiles(item.distanceMiles)));
            lines.push(detailLine('Matched Location', item.locationName));
            lines.push(detailLine('Depth (km)', item.depthKm));
            lines.push(detailLine('USGS Alert', item.alertLevel));
            lines.push(detailLine('Status', item.status));
          } else if (type === 'tsunamis') {
            lines.push(detailLine('Updated', item.updated || item.published));
            lines.push(detailLine('Summary', item.summary));
          } else if (type === 'forecasts') {
            lines.push(detailLine('Location', item.locationName));
            lines.push(detailLine('Window', (item.startTime || '') + ' to ' + (item.endTime || '')));
            lines.push(detailLine('Temperature', normalizeForecastTemp(item.temperature, item.temperatureUnit)));
            lines.push(detailLine('Forecast', item.detailedForecast || item.shortForecast));
          } else if (type === 'cyclones') {
            lines.push(detailLine('Title', item.title));
            lines.push(detailLine('Event time', item.geometryDate));
            lines.push(
              '<p class="muted" style="margin:0 0 10px 0;font-size:13px;line-height:1.45;">Feed product URLs are often blocked off-network; search finds public coverage.</p>'
            );
            const searchUrl = cyclonesWebSearchUrl(item);
            lines.push(
              '<button class="btn" onclick="openExternalUrl(\\'' + escapeHtml(searchUrl).replace(/'/g, '&#039;') + '\\')">Search the web</button>'
            );
          } else if (type === 'wildfires') {
            lines.push(detailLine('Title', item.title));
            lines.push(detailLine('Event time', item.geometryDate));
            lines.push(
              '<p class="muted" style="margin:0 0 10px 0;font-size:13px;line-height:1.45;">Feed links often point to restricted government portals (for example IRWIN) that require sign-in. Use search for public news and maps.</p>'
            );
            const searchUrl = wildfiresWebSearchUrl(item);
            lines.push(
              '<button class="btn" onclick="openExternalUrl(\\'' + escapeHtml(searchUrl).replace(/'/g, '&#039;') + '\\')">Search the web</button>'
            );
          } else {
            lines.push(detailLine('Title', item.title || item.event || item.name || item.message));
            lines.push(detailLine('Severity', item.severity));
            lines.push(detailLine('Location', item.locationName || item.areaDesc));
            lines.push(detailLine('Time', item.time || item.updated || item.published || item.geometryDate));
            lines.push(detailLine('Summary', item.headline || item.description || item.summary || item.shortForecast));
          }
          if (type !== 'cyclones' && type !== 'wildfires' && sourceUrl && /^https?:\\/\\//i.test(sourceUrl)) {
            lines.push(
              '<button class="btn" onclick="openExternalUrl(\\'' + escapeHtml(sourceUrl).replace(/'/g, '&#039;') + '\\')">Open Official Source</button>'
            );
          }
          return lines.filter(Boolean).join('');
        }

        function openEventDetail(type, index) {
          destroyUsgsDetailMap();
          usgsDetailMapRequestId += 1;
          const mapRequestId = usgsDetailMapRequestId;
          const group = detailItems[type];
          const item = Array.isArray(group) ? group[index] : null;
          if (!item) return;
          const title =
            item.event || item.title || item.name || item.message || (type.toUpperCase() + ' Event');
          let titleText = title;
          if (titleText != null && typeof titleText !== 'string') titleText = String(titleText);
          const modal = document.getElementById('dashboardDetailModal');
          const titleEl = document.getElementById('dashboardDetailTitle');
          const bodyEl = document.getElementById('dashboardDetailBody');
          if (!modal || !titleEl || !bodyEl) return;
          titleEl.textContent = String(titleText).slice(0, 500);
          bodyEl.innerHTML = eventDetailHtml(type, item);
          wireHtmlOnclickAttributes(bodyEl);
          modal.style.display = 'flex';
          if (type === 'usgs') {
            const la = Number(item.latitude);
            const lo = Number(item.longitude);
            if (Number.isFinite(la) && Number.isFinite(lo)) {
              void ensureLeafletLoaded()
                .then(() => {
                  if (mapRequestId !== usgsDetailMapRequestId) return;
                  mountUsgsEventDetailMap(la, lo);
                })
                .catch(() => {});
            }
          }
        }

        function milesBetween(lat1, lon1, lat2, lon2) {
          const toRad = (n) => n * Math.PI / 180;
          const earthRadiusMiles = 3958.8;
          const dLat = toRad(lat2 - lat1);
          const dLon = toRad(lon2 - lon1);
          const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          return earthRadiusMiles * c;
        }

        /** True when a point may receive Canadian federal weather alerts (rough footprint; Alaska US excluded). */
        function isLocationInCanadaAlertsFootprint(lat, lon) {
          const la = Number(lat);
          const lo = Number(lon);
          if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
          if (la < 41.5 || la > 85) return false;
          if (lo < -141.5 || lo > -52) return false;
          if (la < 49.0 && lo > -125.0 && lo < -66.5) return false;
          if (la >= 51.0 && la <= 72.5 && lo >= -169.5 && lo <= -129.0) return false;
          return true;
        }

        function hasSavedLocationInCanadaAlertsFootprint() {
          return Boolean(
            config &&
              Array.isArray(config.locations) &&
              config.locations.some((loc) => isLocationInCanadaAlertsFootprint(loc.latitude, loc.longitude))
          );
        }

        function syncCanadaAlertsSectionVisibility() {
          const wrap = document.getElementById('canadaAlertsSection');
          const show = hasSavedLocationInCanadaAlertsFootprint();
          if (wrap) wrap.style.display = show ? '' : 'none';
          if (!show) {
            const el = document.getElementById('canadaResults');
            if (el) el.innerHTML = '';
            detailItems.canada = [];
          }
        }

        function getBoundingBox(locations, milesRadius = 150) {
          const padDegrees = Math.max(0.3, milesRadius / 69);
          const lats = locations.map((loc) => loc.latitude);
          const lons = locations.map((loc) => loc.longitude);
          return {
            minLat: Math.max(-90, Math.min(...lats) - padDegrees),
            maxLat: Math.min(90, Math.max(...lats) + padDegrees),
            minLon: Math.max(-180, Math.min(...lons) - padDegrees),
            maxLon: Math.min(180, Math.max(...lons) + padDegrees)
          };
        }

        function closeNavDrawer() {
          const drawer = document.getElementById('navDrawer');
          const backdrop = document.getElementById('navDrawerBackdrop');
          const btn = document.getElementById('navHamburgerBtn');
          if (drawer) drawer.classList.remove('nav-drawer-open');
          if (backdrop) backdrop.classList.remove('nav-backdrop-visible');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        }

        function toggleNavDrawer() {
          const drawer = document.getElementById('navDrawer');
          const backdrop = document.getElementById('navDrawerBackdrop');
          const btn = document.getElementById('navHamburgerBtn');
          if (!drawer || !backdrop) return;
          const opening = !drawer.classList.contains('nav-drawer-open');
          if (opening) {
            drawer.classList.add('nav-drawer-open');
            backdrop.classList.add('nav-backdrop-visible');
            if (btn) btn.setAttribute('aria-expanded', 'true');
          } else {
            closeNavDrawer();
          }
        }

        function showPage(pageName) {
          const pages = ['weather', 'earthquakes', 'cyclones', 'wildfires', 'settings', 'about', 'contact'];
          for (const p of pages) {
            const el = document.getElementById(p + '-page');
            if (el) el.style.display = p === pageName ? 'block' : 'none';
          }
          if (pageName === 'settings') {
            void refreshBackupPanel();
            void loadAlertSounds().then(() => {
              applyAlertSettingsFields();
              applyCriticalAlertsProLock();
            });
          }
          if (pageName === 'settings' || pageName === 'about') {
            void refreshPlanSummaryBlurb();
          }
          closeNavDrawer();
        }

        async function refreshPlanSummaryBlurb() {
          const settingsEl = document.getElementById('settingsPlanSummary');
          const aboutEl = document.getElementById('aboutPlanSummary');
          if (!settingsEl && !aboutEl) return;
          const clear = () => {
            if (settingsEl) settingsEl.textContent = '';
            if (aboutEl) aboutEl.textContent = '';
          };
          try {
            const state = await ipcRenderer.invoke('core-auth-state');
            if (!state || !state.authenticated || !state.entitlement || !state.entitlement.allow) {
              licenseProUnlocked = false;
              guestLiveDataCapped = false;
              clear();
              applyCriticalAlertsProLock();
              updateGuestModeBanner();
              return;
            }
            licenseProUnlocked = Boolean(state.entitlement.proUnlocked);
            let text;
            guestLiveDataCapped = Boolean(state.guestLocal);
            if (state.guestLocal) {
              text =
                'Local use without a saved Root Record account. The sign-in screen appears on every launch until you sign in. Pro-only features stay locked until then. Live hazard feeds (NOAA, USGS, NASA EONET, etc.) can be refreshed at most once per 24 hours; sign in for automatic updates and unlimited manual refresh.';
            } else if (state.entitlement.proUnlocked) {
              text = 'Your plan: Pro — thank you for supporting Root Record.';
            } else {
              const r = String(state.entitlement.reason || '').toLowerCase();
              const tr = String(state.entitlement.trialRemaining || '').trim();
              const label = (tr || r === 'trialing') ? 'Standard' : 'Free';
              text =
                'Your plan: ' +
                label +
                ' — hazard feeds and local database snapshots on this device are included.';
            }
            if (settingsEl) settingsEl.textContent = text;
            if (aboutEl) aboutEl.textContent = text;
          } catch {
            licenseProUnlocked = false;
            guestLiveDataCapped = false;
            clear();
          }
          applyCriticalAlertsProLock();
          updateGuestModeBanner();
        }

        function onUnitSystemChanged() {
          const sel = document.getElementById('unitSystem');
          if (!sel) return;
          config.unitSystem = sel.value === 'metric' ? 'metric' : 'imperial';
          applyRadiusLabelAndValue();
          applyAlertSettingsFields();
        }

        async function openRootRecordWebsite() {
          await ipcRenderer.invoke('open-rootrecord-website');
        }

        async function emailRootRecordSupport() {
          await ipcRenderer.invoke('email-rootrecord-support');
        }

        async function openDiscordSupport() {
          await ipcRenderer.invoke('open-external-url', 'https://discord.gg/CPaDYuFkU');
        }

        async function checkForUpdatesFromAbout() {
          try {
            await ipcRenderer.invoke('weather-check-for-updates');
          } catch (e) {
            alert('Could not check for updates: ' + (e && e.message ? e.message : String(e)));
          }
        }

        function setAuthStatus(kind, text) {
          const el = document.getElementById('authStatus');
          if (!el) return;
          const msg = text == null ? '' : String(text);
          if (!msg.trim()) {
            el.textContent = '';
            el.className = 'status';
            el.style.display = 'none';
            return;
          }
          el.style.display = '';
          el.className = 'status ' + kind;
          el.textContent = msg;
        }

        function humanizeLicenseGateError(err) {
          let raw = err && err.message ? String(err.message) : String(err || '');
          raw = raw.replace(/^Error invoking remote method '[^']*':\\s*/, '').replace(/^Error:\\s*/, '').trim();
          const blob = raw;
          if (blob.includes('LR_AUTH_INVALID_PASSWORD')) return 'Password incorrect, please try again.';
          if (blob.includes('LR_AUTH_ACCOUNT_NOT_FOUND')) {
            return 'No account found. Create an account or check your email and password.';
          }
          if (blob.includes('LR_AUTH_LEGACY_AMBIGUOUS')) {
            return 'Could not sign in. Check your email and password, or create an account if you are new.';
          }
          if (blob.includes('LR_AUTH_PASSWORD_NOT_SET') || blob.includes('PASSWORD_NOT_SET')) {
            return 'This account does not have a password set yet. Finish setup on the device where you first used RootRecord, then try again here.';
          }
          if (blob.includes('LR_AUTH_DEVICE_CONFLICT') || blob.includes('DEVICE_CONFLICT')) {
            return 'This device is registered to a different RootRecord account. Sign in with the email that first used this PC, or contact support.';
          }
          if (blob.includes('LR_AUTH_INVALID_DEVICE_ID')) {
            return 'Could not verify this PC’s device ID. Quit the app fully and reopen, or reinstall if this repeats.';
          }
          if (
            /fetch failed|network|ECONNREFUSED|ENOTFOUND|timed out|connect timeout|UND_ERR_CONNECT_TIMEOUT/i.test(
              blob
            )
          ) {
            return 'Could not reach RootRecord servers. Check your internet connection and try again.';
          }
          return raw || 'Sign-in failed.';
        }

        async function authLogout() {
          if (!confirm('Sign out of your Root Record account on this device?')) return;
          try {
            await ipcRenderer.invoke('core-auth-logout');
            window.location.reload();
          } catch (e) {
            alert('Sign out failed: ' + (e && e.message ? e.message : String(e)));
          }
        }

        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('keydown', (ev) => {
            if (ev && ev.key === 'Escape') closeNavDrawer();
          });
        }

        if (typeof window !== 'undefined') {
          window.addEventListener('error', (event) => {
            const message = event && event.error && event.error.message
              ? event.error.message
              : (event && event.message ? event.message : 'Unknown renderer error');
            setAuthStatus('error', 'UI runtime error: ' + message);
          });
          window.addEventListener('unhandledrejection', (event) => {
            const reason = event && event.reason;
            const message = reason && reason.message ? reason.message : String(reason || 'Unknown async error');
            setAuthStatus('error', 'UI async error: ' + message);
          });
        }

        function updateGuestModeBanner() {
          const el = document.getElementById('guestModeBanner');
          if (!el) return;
          el.style.display = guestLiveDataCapped ? 'block' : 'none';
        }

        function showMainApp() {
          setAuthStatus('', '');
          const gate = document.getElementById('authGate');
          const appShell = document.getElementById('appShell');
          if (gate) gate.style.display = 'none';
          if (appShell) appShell.style.display = 'flex';
          updateGuestModeBanner();
        }

        async function initializeAuthGate() {
          try {
            const state = await Promise.race([
              ipcRenderer.invoke('core-auth-state'),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Session check timed out. Please sign in manually.')), 15000))
            ]);
            if (state.authenticated) {
              guestLiveDataCapped = Boolean(state.guestLocal);
              await loadConfig();
              showMainApp();
              void refreshPlanSummaryBlurb();
              return;
            }
            const emailInput = document.getElementById('authEmail');
            if (emailInput && state.email) emailInput.value = state.email;
            guestLiveDataCapped = false;
            setAuthStatus('warn', state.message || 'Sign in required.');
            const gateEl = document.getElementById('authGate');
            const shellEl = document.getElementById('appShell');
            if (gateEl) gateEl.style.display = 'flex';
            if (shellEl) shellEl.style.display = 'none';
          } catch (error) {
            guestLiveDataCapped = false;
            setAuthStatus('error', 'Auth check failed: ' + error.message);
            const gateEl = document.getElementById('authGate');
            const shellEl = document.getElementById('appShell');
            if (gateEl) gateEl.style.display = 'flex';
            if (shellEl) shellEl.style.display = 'none';
          }
        }

        async function authSignIn() {
          const email = (document.getElementById('authEmail') || {}).value || '';
          const password = (document.getElementById('authPassword') || {}).value || '';
          setAuthStatus('warn', 'Signing in...');
          try {
            const result = await ipcRenderer.invoke('core-auth-login', { email, password });
            if (result && result.entitlement && result.entitlement.allow) {
              setAuthStatus('ok', 'Sign-in successful.');
              guestLiveDataCapped = false;
              await loadConfig();
              showMainApp();
              void refreshPlanSummaryBlurb();
            } else {
              setAuthStatus(
                'warn',
                'Signed in, but Weather Manager did not open for this account yet. Check RootRecord.com or try again later.'
              );
            }
          } catch (error) {
            setAuthStatus('error', humanizeLicenseGateError(error));
          }
        }

        async function authContinueWithoutAccount() {
          setAuthStatus('warn', 'Opening local session…');
          try {
            await ipcRenderer.invoke('core-auth-continue-without-account');
            guestLiveDataCapped = true;
            await loadConfig();
            showMainApp();
            void refreshPlanSummaryBlurb();
          } catch (error) {
            setAuthStatus('error', error && error.message ? error.message : String(error));
          }
        }

        async function authSignUp() {
          const email = (document.getElementById('authEmail') || {}).value || '';
          const password = (document.getElementById('authPassword') || {}).value || '';
          setAuthStatus('warn', 'Creating account...');
          try {
            const result = await ipcRenderer.invoke('core-auth-signup', { email, password });
            if (result && result.entitlement && result.entitlement.allow) {
              setAuthStatus('ok', 'Account created. You’re signed in.');
              guestLiveDataCapped = false;
              await loadConfig();
              showMainApp();
              void refreshPlanSummaryBlurb();
            } else {
              setAuthStatus('warn', 'Account created, but access not yet granted.');
            }
          } catch (error) {
            setAuthStatus('error', humanizeLicenseGateError(error));
          }
        }

        async function startCheckout() {
          setAuthStatus('warn', 'Opening subscription checkout...');
          try {
            await ipcRenderer.invoke('core-auth-checkout');
            setAuthStatus('ok', 'Checkout opened in your browser. Return after purchase and sign in again.');
          } catch (error) {
            setAuthStatus('error', 'Checkout failed: ' + error.message);
          }
        }

        async function renderArchiveSummary() {
          const summary = document.getElementById('archiveSummary');
          if (!summary) return;
          const archive = await ipcRenderer.invoke('archive-summary');
          summary.textContent =
            'U.S. weather saved records: ' + archive.noaa +
            '\\nCanada weather saved records: ' + archive.canada +
            '\\nUSGS saved records: ' + archive.usgs +
            '\\nTsunami saved records: ' + archive.tsunamis +
            '\\nWeather dashboard snapshots: ' + archive.noaaDashboard +
            '\\nCyclone saved records: ' + archive.cyclones +
            '\\nWildfire saved records: ' + archive.wildfires +
            '\\nForecast saved records: ' + archive.forecasts;
        }

        async function restoreFromArchive() {
          try {
            const snapshot = await ipcRenderer.invoke('archive-latest', { count: 250 });
            const noaaItems = Array.isArray(snapshot.noaa) ? snapshot.noaa : [];
            const canadaItems = Array.isArray(snapshot.canada) ? snapshot.canada : [];
            const usgsItems = Array.isArray(snapshot.usgs) ? snapshot.usgs : [];
            const tsunamiItems = Array.isArray(snapshot.tsunamis) ? snapshot.tsunamis : [];
            const dashboard = snapshot.noaaDashboard && typeof snapshot.noaaDashboard === 'object' ? snapshot.noaaDashboard : null;
            const cycloneItems = Array.isArray(snapshot.cyclones) ? snapshot.cyclones : [];
            const wildfireItems = Array.isArray(snapshot.wildfires) ? snapshot.wildfires : [];
            const forecastItems = Array.isArray(snapshot.forecasts) ? snapshot.forecasts : [];

            if (dashboard) renderNoaaDashboard(dashboard);
            renderNoaa(noaaItems);
            syncCanadaAlertsSectionVisibility();
            renderCanadaAlerts(canadaItems);
            usgsItems.sort((a, b) => (Number(b.timeMs) || 0) - (Number(a.timeMs) || 0));
            renderUsgs(usgsItems);
            renderTsunamis(tsunamiItems);
            renderCyclones(cycloneItems);
            renderWildfires(wildfireItems);
            renderForecasts(forecastItems);
          } catch {
            // Ignore archive restore failures to keep startup resilient.
          }
        }

        function hideSetupFinalizeConfirm() {
          if (setupFinalizeConfirmTimer) {
            clearTimeout(setupFinalizeConfirmTimer);
            setupFinalizeConfirmTimer = null;
          }
          const el = document.getElementById('setupFinalizeConfirm');
          if (el) {
            el.style.display = 'none';
            el.textContent = '';
          }
        }

        function showSetupFinalizeConfirm() {
          hideSetupFinalizeConfirm();
          const el = document.getElementById('setupFinalizeConfirm');
          if (!el) return;
          el.style.display = '';
          el.className = 'status ok';
          el.textContent = 'Settings saved successfully.';
          setupFinalizeConfirmTimer = setTimeout(() => {
            hideSetupFinalizeConfirm();
          }, 6000);
        }

        function renderSetupState() {
          const setupStatus = document.getElementById('setupStatus');
          const settingsRefreshAllBtn = document.getElementById('settingsRefreshAllBtn');
          if (config.isConfigured) {
            if (setupStatus) {
              setupStatus.style.display = 'none';
              setupStatus.textContent = '';
            }
            if (settingsRefreshAllBtn) settingsRefreshAllBtn.disabled = false;
          } else {
            if (setupStatus) {
              setupStatus.style.display = '';
              setupStatus.className = 'status error';
              setupStatus.textContent = 'Setting Not Configured';
            }
            if (settingsRefreshAllBtn) settingsRefreshAllBtn.disabled = true;
          }
          syncCanadaAlertsSectionVisibility();
        }

        function renderLocations() {
          const list = document.getElementById('locationList');
          if (!config.locations.length) {
            list.innerHTML = '<p class="muted">No locations configured yet.</p>';
            return;
          }
          list.innerHTML = config.locations.map((loc, idx) => {
            return \`
              <div class="location-row">
                <div>
                  <strong>\${escapeHtml(loc.name)}</strong><br/>
                  <span class="muted">\${loc.latitude.toFixed(4)}, \${loc.longitude.toFixed(4)}</span>
                </div>
                <button class="btn danger" onclick="removeLocation(\${idx})">Remove</button>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(list);
        }

        async function refreshBackupPanel() {
          try {
            const data = await ipcRenderer.invoke('backup-get-state');
            const s = data.settings || {};
            const autoEl = document.getElementById('autoBackupToggle');
            if (autoEl) autoEl.checked = Boolean(s.auto_backup_enabled);
            const hoursEl = document.getElementById('autoBackupHours');
            if (hoursEl) hoursEl.value = String(Math.max(1, parseInt(String(s.auto_backup_interval_hours || 24), 10) || 24));
          } catch {
            /* ignore */
          }
        }

        async function saveBackupSettings() {
          const autoEl = document.getElementById('autoBackupToggle');
          const hoursEl = document.getElementById('autoBackupHours');
          const payload = {
            auto_backup_enabled: Boolean(autoEl && autoEl.checked),
            auto_backup_interval_hours: Math.max(1, parseInt(String((hoursEl && hoursEl.value) || '24'), 10) || 24)
          };
          await ipcRenderer.invoke('backup-save-settings', payload);
          await refreshBackupPanel();
        }

        async function backupDatabaseNow() {
          try {
            await ipcRenderer.invoke('backup-now', 'manual');
            await refreshBackupPanel();
            alert('Local database backup completed.');
          } catch (e) {
            alert('Backup failed: ' + (e && e.message ? e.message : String(e)));
          }
        }

        async function openBackupFolder() {
          await ipcRenderer.invoke('backup-open-folder');
        }

        async function loadConfig() {
          config = await ipcRenderer.invoke('get-location-config');
          const openAtLogin = await ipcRenderer.invoke('get-open-at-login');
          const openAtLoginToggle = document.getElementById('openAtLoginToggle');
          if (openAtLoginToggle) openAtLoginToggle.checked = Boolean(openAtLogin);
          const unitSel = document.getElementById('unitSystem');
          if (unitSel) unitSel.value = config.unitSystem === 'metric' ? 'metric' : 'imperial';
          await loadAlertSounds();
          applyRadiusLabelAndValue();
          applyAlertSettingsFields();
          renderLocations();
          renderSetupState();
          await restoreFromArchive();
          await renderArchiveSummary();
          await refreshBackupPanel();
          await refreshPlanSummaryBlurb();
          restoreDataLastUpdatedLabel();
        }

        async function toggleOpenAtLogin() {
          const openAtLoginToggle = document.getElementById('openAtLoginToggle');
          if (!openAtLoginToggle) return;
          await ipcRenderer.invoke('set-open-at-login', Boolean(openAtLoginToggle.checked));
        }

        async function addLocation() {
          const name = document.getElementById('locationName').value.trim();
          const latitude = toNumber(document.getElementById('locationLat').value.trim());
          const longitude = toNumber(document.getElementById('locationLon').value.trim());
          const radiusUiRaw = toNumber(document.getElementById('radiusMiles').value.trim());
          const radiusUi = radiusUiRaw === null || radiusUiRaw <= 0 ? storedMilesToUiRadius(150) : radiusUiRaw;
          const radiusMiles = uiRadiusToStoredMiles(radiusUi);
          if (!name) {
            alert('Location name is required.');
            return;
          }
          if (latitude === null || longitude === null) {
            alert('Latitude and longitude must be valid numbers.');
            return;
          }
          if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            alert('Latitude must be -90 to 90 and longitude must be -180 to 180.');
            return;
          }
          config.locations.push({ name, latitude, longitude });
          config.isConfigured = false;
          hideSetupFinalizeConfirm();
          config.radiusMiles = radiusMiles;
          config.unitSystem = getUnitSystem();
          config = await ipcRenderer.invoke('save-location-config', config);
          document.getElementById('locationName').value = '';
          document.getElementById('locationLat').value = '';
          document.getElementById('locationLon').value = '';
          applyRadiusLabelAndValue();
          renderLocations();
          renderSetupState();
        }

        async function removeLocation(index) {
          config.locations.splice(index, 1);
          config.isConfigured = false;
          hideSetupFinalizeConfirm();
          const radiusUi = toNumber(document.getElementById('radiusMiles').value.trim());
          if (radiusUi && radiusUi > 0) config.radiusMiles = uiRadiusToStoredMiles(radiusUi);
          config.unitSystem = getUnitSystem();
          config = await ipcRenderer.invoke('save-location-config', config);
          applyRadiusLabelAndValue();
          renderLocations();
          renderSetupState();
        }

        async function completeSetup() {
          const radiusUiRaw = toNumber(document.getElementById('radiusMiles').value.trim());
          const radiusUi = radiusUiRaw === null || radiusUiRaw <= 0 ? storedMilesToUiRadius(150) : radiusUiRaw;
          const radiusMiles = uiRadiusToStoredMiles(radiusUi);
          if (!config.locations.length) {
            alert('At least one location is required before finalizing setup.');
            return;
          }
          config.radiusMiles = radiusMiles;
          config.unitSystem = getUnitSystem();
          config.isConfigured = true;
          config = await ipcRenderer.invoke('save-location-config', config);
          applyRadiusLabelAndValue();
          renderSetupState();
          showSetupFinalizeConfirm();
          void refreshData();
        }

        function renderNoaa(items) {
          const el = document.getElementById('noaaResults');
          detailItems.noaa = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active alerts near your configured locations.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('noaa', \${index})">
                <strong>\${escapeHtml(item.event || 'Alert')}</strong><br/>
                <span class="muted">\${escapeHtml(item.severity || 'Unknown severity')} | \${escapeHtml(item.areaDesc || 'No area provided')}</span><br/>
                <span class="muted">Matched location: \${escapeHtml(item.locationName)}</span><br/>
                <span>\${escapeHtml(item.headline || 'No headline')}</span>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(el);
        }

        function renderNoaaDashboard(data) {
          const currentEl = document.getElementById('weatherCurrentCard');
          const dailyEl = document.getElementById('weatherDailyCard');
          const avgEl = document.getElementById('weatherAveragesCard');
          const radarEl = document.getElementById('weatherRadarCard');
          const satelliteEl = document.getElementById('weatherSatelliteCard');
          if (!currentEl || !dailyEl || !avgEl || !radarEl || !satelliteEl) return;

          const currentRows = Array.isArray(data && data.current) ? data.current : [];
          if (!currentRows.length) {
            currentEl.innerHTML = '<span class="muted">No current conditions available.</span>';
          } else {
            currentEl.innerHTML = currentRows.map((row) => {
              return \`
                <div style="margin-bottom:10px;">
                  <strong style="font-size:15px;">\${escapeHtml(row.locationName)}</strong><br/>
                  <span class="muted">\${escapeHtml(row.text || 'Current')}</span><br/>
                  <span>Temp: \${escapeHtml(formatTemperatureF(row.temperatureF))}, Wind: \${escapeHtml(formatWindMph(row.windMph))}</span>
                </div>
              \`;
            }).join('');
          }

          const dailyRows = Array.isArray(data && data.daily) ? data.daily : [];
          if (!dailyRows.length) {
            dailyEl.innerHTML = '<span class="muted">No daily forecast periods available.</span>';
          } else {
            dailyEl.innerHTML = dailyRows.map((row) => {
              return \`
                <div style="margin-bottom:8px;">
                  <strong>\${escapeHtml(row.locationName)} - \${escapeHtml(row.name)}</strong><br/>
                  <span>\${escapeHtml(row.shortForecast || '')}</span><br/>
                  <span class="muted">\${escapeHtml(normalizeForecastTemp(row.temperature, row.temperatureUnit))}</span>
                </div>
              \`;
            }).join('');
          }

          const avgRows = Array.isArray(data && data.averages) ? data.averages : [];
          if (!avgRows.length) {
            avgEl.innerHTML = '<span class="muted">No hourly data available for averages.</span>';
          } else {
            avgEl.innerHTML = avgRows.map((row) => {
              return \`
                <div style="margin-bottom:8px;">
                  <strong>\${escapeHtml(row.locationName)}</strong><br/>
                  <span>Avg Temp (24h): \${escapeHtml(formatTemperatureF(row.avgTempF))}</span><br/>
                  <span>Avg Wind (24h): \${escapeHtml(formatWindMph(row.avgWindMph))}</span>
                </div>
              \`;
            }).join('');
          }

          const radarRows = Array.isArray(data && data.radar) ? data.radar : [];
          if (!radarRows.length) {
            radarEl.innerHTML = '<span class="muted">No radar station assets available for configured locations.</span>';
          } else {
            radarEl.innerHTML = radarRows.map((row) => {
              return \`
                <div style="margin-bottom:10px;">
                  <strong>\${escapeHtml(row.locationName)}</strong><br/>
                  <span class="muted">Station: \${escapeHtml(row.station)}</span><br/>
                  <img src="\${escapeHtml(row.url)}" alt="Radar loop" style="width:100%;max-height:min(420px,55vh);object-fit:contain;border:1px solid #333;border-radius:4px;background:#111;" />
                </div>
              \`;
            }).join('');
          }

          const satelliteRows = Array.isArray(data && data.satellite) ? data.satellite : [];
          if (!satelliteRows.length) {
            satelliteEl.innerHTML = '<span class="muted">No satellite assets available.</span>';
          } else {
            satelliteEl.innerHTML =
              '<div class="weather-satellite-strip">' +
              satelliteRows
                .map((row) => {
                  return (
                    '<div class="weather-satellite-cell">' +
                    '<strong>' +
                    escapeHtml(row.label) +
                    '</strong>' +
                    '<img src="' +
                    escapeHtml(row.url) +
                    '" alt="Satellite image" />' +
                    '</div>'
                  );
                })
                .join('') +
              '</div>';
          }
        }

        function renderCanadaAlerts(items) {
          const el = document.getElementById('canadaResults');
          if (!el) return;
          if (!hasSavedLocationInCanadaAlertsFootprint()) {
            detailItems.canada = [];
            el.innerHTML = '';
            return;
          }
          detailItems.canada = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active Canada-region alerts for your saved locations.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('canada', \${index})">
                <strong>\${escapeHtml(item.event || item.title || 'Alert')}</strong><br/>
                <span class="muted">\${escapeHtml(item.severity || 'Unknown severity')} | \${escapeHtml(item.areaDesc || 'No area provided')}</span><br/>
                <span class="muted">Matched location: \${escapeHtml(item.locationName)}</span><br/>
                <span>\${escapeHtml(item.headline || item.description || 'No headline')}</span>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(el);
        }

        function renderUsgs(items) {
          const el = document.getElementById('usgsResults');
          detailItems.usgs = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No recent earthquakes within your configured radius.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('usgs', \${index})">
                <strong>M\${escapeHtml(item.magnitude)} - \${escapeHtml(item.place)}</strong><br/>
                <span class="muted">\${escapeHtml(item.time)} | \${escapeHtml(formatDistanceFromMiles(item.distanceMiles))} from \${escapeHtml(item.locationName)}</span>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(el);
        }

        function renderTsunamis(items) {
          const el = document.getElementById('tsunamiResults');
          if (!el) return;
          detailItems.tsunamis = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active tsunami bulletins found.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('tsunamis', \${index})">
                <strong>\${escapeHtml(item.title || 'Tsunami Bulletin')}</strong><br/>
                <span class="muted">\${escapeHtml(item.updated || item.published || '')}</span><br/>
                <span>\${escapeHtml(item.summary || 'No bulletin summary')}</span>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(el);
        }

        function renderCyclones(items) {
          const el = document.getElementById('cycloneResults');
          if (!el) return;
          detailItems.cyclones = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active cyclone events found.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('cyclones', \${index})">
                <strong>\${escapeHtml(item.title || 'Cyclone Event')}</strong><br/>
                <span class="muted">\${escapeHtml(item.geometryDate || '')}</span><br/>
                <span class="muted">NASA EONET · open for web search</span>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(el);
        }

        function renderWildfires(items) {
          const el = document.getElementById('wildfireResults');
          if (!el) return;
          detailItems.wildfires = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No active wildfire events found.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('wildfires', \${index})">
                <strong>\${escapeHtml(item.title || 'Wildfire Event')}</strong><br/>
                <span class="muted">\${escapeHtml(item.geometryDate || '')}</span><br/>
                <span class="muted">NASA EONET · open for web search</span>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(el);
        }

        function renderForecasts(items) {
          const el = document.getElementById('forecastResults');
          if (!el) return;
          detailItems.forecasts = Array.isArray(items) ? items : [];
          if (!items.length) {
            el.innerHTML = '<p class="muted">No future forecast periods available for configured locations.</p>';
            return;
          }
          el.innerHTML = items.map((item, index) => {
            return \`
              <div class="card clickable-card" onclick="openEventDetail('forecasts', \${index})">
                <strong>\${escapeHtml(item.locationName)} - \${escapeHtml(item.name || 'Forecast')}</strong><br/>
                <span class="muted">\${escapeHtml(item.startTime || '')} to \${escapeHtml(item.endTime || '')}</span><br/>
                <span>\${escapeHtml(item.detailedForecast || item.shortForecast || '')}</span><br/>
                <span class="muted">\${escapeHtml(normalizeForecastTemp(item.temperature, item.temperatureUnit))}</span>
              </div>
            \`;
          }).join('');
          wireHtmlOnclickAttributes(el);
        }

        function isCriticalNoaaEvent(item) {
          const event = String(item.event || '').toLowerCase();
          const severity = String(item.severity || '').toLowerCase();
          const criticalKeywords = ['tornado', 'hurricane', 'tsunami', 'flash flood warning', 'blizzard', 'severe thunderstorm warning'];
          return severity === 'extreme' || severity === 'severe' || criticalKeywords.some((key) => event.includes(key));
        }

        async function maybeTriggerCriticalPopup(noaaItems, usgsItems, canadaItems) {
          if (!licenseProUnlocked) return;
          const prefs = getAlertPrefs();
          const criticalNoaa = prefs.weatherEnabled ? noaaItems.filter(isCriticalNoaaEvent) : [];
          const criticalCanada = prefs.weatherEnabled ? (canadaItems || []).filter((item) => isCriticalNoaaEvent(item)) : [];
          const criticalUsgs = prefs.usgsEnabled
            ? usgsItems.filter((item) => {
              const magnitude = Number(item.magnitude);
              const distance = Number(item.distanceMiles);
              return Number.isFinite(magnitude) &&
                magnitude >= prefs.usgsMinMagnitude &&
                Number.isFinite(distance) &&
                distance <= prefs.usgsMaxDistanceMiles;
            })
            : [];
          if (!criticalNoaa.length && !criticalUsgs.length && !criticalCanada.length) return;
          const lines = [];
          for (const item of criticalNoaa.slice(0, 6)) {
            lines.push('[U.S. Weather] ' + (item.event || 'Critical alert') + ' near ' + item.locationName);
          }
          for (const item of criticalCanada.slice(0, 6)) {
            lines.push('[Canada] ' + (item.event || item.title || 'Critical alert') + ' near ' + item.locationName);
          }
          for (const item of criticalUsgs.slice(0, 6)) {
            lines.push('[USGS] M' + item.magnitude + ' - ' + item.place + ' (' + formatDistanceFromMiles(item.distanceMiles) + ' from ' + item.locationName + ')');
          }
          playAlertSound(prefs.soundPath);
          await ipcRenderer.invoke('show-critical-popup', {
            title: 'Critical Weather / Seismic Alert',
            lines
          });
        }

        async function refreshNoaa() {
          if (!config.isConfigured || !config.locations.length) {
            alert('Setup must be completed before data can be retrieved.');
            return;
          }
          await withGuestLiveBundle(async () => {
          try {
            syncCanadaAlertsSectionVisibility();
            const includeCanada = hasSavedLocationInCanadaAlertsFootprint();
            const noaa = await ipcRenderer.invoke('fetch-noaa-alerts');
            let canada = { features: [] };
            if (includeCanada) {
              canada = await ipcRenderer.invoke('fetch-canada-alerts');
            }
            const dashboard = await ipcRenderer.invoke('fetch-noaa-dashboard', { locations: config.locations });

            const filteredNoaa = [];
            for (const feature of noaa.features || []) {
              const props = feature.properties || {};
              const area = String(props.areaDesc || '').toLowerCase();
              for (const loc of config.locations) {
                if (area.includes(loc.name.toLowerCase())) {
                  filteredNoaa.push({
                    id: props.id || props.messageType || props.event + ':' + props.sent,
                    event: props.event,
                    severity: props.severity,
                    areaDesc: props.areaDesc,
                    headline: props.headline,
                    locationName: loc.name
                  });
                  break;
                }
              }
            }
            const filteredCanada = [];
            if (includeCanada) {
              for (const feature of canada.features || []) {
                const props = feature.properties || {};
                const area = String(
                  props.areaDesc ||
                  props.area ||
                  props.title ||
                  props.description ||
                  ''
                ).toLowerCase();
                for (const loc of config.locations) {
                  if (area.includes(loc.name.toLowerCase())) {
                    filteredCanada.push({
                      id: props.id || props.identifier || props.title,
                      event: props.event || props.type || props.title,
                      severity: props.severity || props.urgency || props.certainty,
                      areaDesc: props.areaDesc || props.area || props.title,
                      headline: props.headline || props.description || props.title,
                      locationName: loc.name,
                      title: props.title,
                      description: props.description
                    });
                    break;
                  }
                }
              }
            }
            await ipcRenderer.invoke('archive-noaa', filteredNoaa);
            await ipcRenderer.invoke('archive-canada', filteredCanada);
            await ipcRenderer.invoke('archive-noaa-dashboard', dashboard ? [dashboard] : []);
            await ipcRenderer.invoke('store-records', {
              source: 'NOAA',
              category: 'weather_alert',
              isForecast: false,
              records: filteredNoaa.map((item) => ({
                eventTime: null,
                title: item.event,
                severity: item.severity,
                locationName: item.locationName,
                ...item
              }))
            });
            await ipcRenderer.invoke('store-records', {
              source: 'Environment Canada',
              category: 'weather_alert',
              isForecast: false,
              records: filteredCanada.map((item) => ({
                eventTime: null,
                title: item.event || item.title,
                severity: item.severity,
                locationName: item.locationName,
                ...item
              }))
            });
            await maybeTriggerCriticalPopup(filteredNoaa, [], includeCanada ? filteredCanada : []);
            await renderArchiveSummary();
            renderNoaaDashboard(dashboard);
            renderNoaa(filteredNoaa);
            renderCanadaAlerts(filteredCanada);
            touchDataLastUpdated();
          } catch (error) {
            alert('Weather refresh failed: ' + error.message);
          }
          });
        }


        async function refreshWeather() {
          if (!config.isConfigured || !config.locations.length) {
            alert('Setup must be completed before data can be retrieved.');
            return;
          }
          await withGuestLiveBundle(async () => {
          try {
            const box = getBoundingBox(config.locations, config.radiusMiles || 150);
            const usgs = await ipcRenderer.invoke('fetch-usgs-events', box);
            const tsunamis = await ipcRenderer.invoke('fetch-tsunami-bulletins');
            const radiusMilesForQuakes = Number(config.radiusMiles || 150);
            const coarseQuakeRadius = Math.max(radiusMilesForQuakes, 200);
            const filteredUsgs = [];
            for (const feature of usgs.features || []) {
              const coords = (feature.geometry && feature.geometry.coordinates) || [];
              const lon = Number(coords[0]);
              const lat = Number(coords[1]);
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
              let nearest = null;
              for (const loc of config.locations) {
                const dist = milesBetween(loc.latitude, loc.longitude, lat, lon);
                if (!nearest || dist < nearest.distance) {
                  nearest = { locationName: loc.name, distance: dist };
                }
              }
              if (nearest && nearest.distance <= coarseQuakeRadius) {
                const timeMs = Number(feature.properties && feature.properties.time) || 0;
                filteredUsgs.push({
                  id: feature.id,
                  magnitude: feature.properties && feature.properties.mag,
                  place: feature.properties && feature.properties.place,
                  time: new Date(timeMs).toLocaleString(),
                  timeMs,
                  distanceMiles: nearest.distance.toFixed(1),
                  locationName: nearest.locationName,
                  latitude: lat,
                  longitude: lon,
                  detailUrl: feature.properties && feature.properties.url,
                  alertLevel: feature.properties && feature.properties.alert,
                  status: feature.properties && feature.properties.status,
                  depthKm: Number.isFinite(Number(coords[2])) ? Number(coords[2]).toFixed(1) : ''
                });
              }
            }
            const radiusFiltered = filteredUsgs
              .filter((item) => Number(item.distanceMiles) <= radiusMilesForQuakes)
              .sort((a, b) => (Number(b.timeMs) || 0) - (Number(a.timeMs) || 0));
            await ipcRenderer.invoke('archive-usgs', radiusFiltered);
            await ipcRenderer.invoke('archive-tsunamis', tsunamis.entries || []);
            await ipcRenderer.invoke('store-records', {
              source: 'USGS',
              category: 'earthquake',
              isForecast: false,
              records: radiusFiltered.map((item) => ({
                eventTime: item.time,
                title: item.place,
                severity: item.magnitude,
                locationName: item.locationName,
                ...item
              }))
            });
            await ipcRenderer.invoke('store-records', {
              source: 'Tsunami Warning Centers',
              category: 'tsunami',
              isForecast: false,
              records: (tsunamis.entries || []).map((entry) => ({
                eventTime: entry.updated || entry.published || null,
                title: entry.title,
                severity: null,
                locationName: null,
                ...entry
              }))
            });
            await maybeTriggerCriticalPopup([], radiusFiltered, []);
            await renderArchiveSummary();
            renderUsgs(radiusFiltered);
            renderTsunamis(tsunamis.entries || []);
            touchDataLastUpdated();
          } catch (error) {
            const msg = String((error && error.message) || error);
            if (/\b400\b/.test(msg) && /USGS|Tsunami bulletin request failed/i.test(msg)) return;
            alert('Earthquake/Tsunami refresh failed: ' + error.message);
          }
          });
        }

        async function refreshCyclones() {
          if (!config.isConfigured || !config.locations.length) return;
          await withGuestLiveBundle(async () => {
          try {
            const data = await ipcRenderer.invoke('fetch-cyclones');
            const items = Array.isArray(data.items) ? data.items : [];
            await ipcRenderer.invoke('archive-cyclones', items);
            await ipcRenderer.invoke('store-records', {
              source: 'NASA EONET',
              category: 'cyclone',
              isForecast: false,
              records: items.map((item) => ({
                eventTime: item.geometryDate || null,
                title: item.title,
                severity: null,
                locationName: null,
                ...item
              }))
            });
            renderCyclones(items);
            await renderArchiveSummary();
            touchDataLastUpdated();
          } catch (error) {
            alert('Cyclone refresh failed: ' + error.message);
          }
          });
        }

        async function refreshWildfires() {
          if (!config.isConfigured || !config.locations.length) return;
          await withGuestLiveBundle(async () => {
          try {
            const data = await ipcRenderer.invoke('fetch-wildfires');
            const items = Array.isArray(data.items) ? data.items : [];
            await ipcRenderer.invoke('archive-wildfires', items);
            await ipcRenderer.invoke('store-records', {
              source: 'NASA EONET',
              category: 'wildfire',
              isForecast: false,
              records: items.map((item) => ({
                eventTime: item.geometryDate || null,
                title: item.title,
                severity: null,
                locationName: null,
                ...item
              }))
            });
            renderWildfires(items);
            await renderArchiveSummary();
            touchDataLastUpdated();
          } catch (error) {
            alert('Wildfire refresh failed: ' + error.message);
          }
          });
        }

        async function refreshData() {
          await withGuestLiveBundle(() =>
            Promise.all([refreshNoaa(), refreshWeather(), refreshCyclones(), refreshWildfires(), refreshForecasts()])
          );
        }

        async function refreshForecasts() {
          if (!config.isConfigured || !config.locations.length) return;
          await withGuestLiveBundle(async () => {
          try {
            try {
              await ipcRenderer.invoke('weather-guest-begin-live-data-burst');
            } catch (burstErr) {
              alert('Forecast refresh failed: ' + (burstErr && burstErr.message ? burstErr.message : String(burstErr)));
              return;
            }
            const allForecasts = [];
            for (const loc of config.locations) {
              const data = await ipcRenderer.invoke('fetch-noaa-forecast', {
                latitude: loc.latitude,
                longitude: loc.longitude
              });
              const periods = data && data.properties && Array.isArray(data.properties.periods)
                ? data.properties.periods
                : [];
              const now = new Date();
              const future = periods
                .filter((period) => period && period.startTime && new Date(period.startTime) > now)
                .map((period) => ({ ...period, locationName: loc.name }));
              allForecasts.push(...future);
            }
            await ipcRenderer.invoke('archive-forecasts', allForecasts);
            await ipcRenderer.invoke('store-records', {
              source: 'NOAA',
              category: 'forecast',
              isForecast: true,
              records: allForecasts.map((item) => ({
                eventTime: item.startTime || null,
                title: item.name,
                severity: null,
                locationName: item.locationName,
                ...item
              }))
            });
            renderForecasts(allForecasts);
            await renderArchiveSummary();
            touchDataLastUpdated();
          } catch (error) {
            alert('Forecast refresh failed: ' + error.message);
          }
          });
        }

        async function refreshAllDataFromSettings() {
          if (!config.isConfigured || !config.locations.length) {
            alert('Setup must be completed before data can be retrieved.');
            return;
          }
          const btn = document.getElementById('settingsRefreshAllBtn');
          if (btn) btn.disabled = true;
          try {
            await refreshData();
          } finally {
            if (btn) btn.disabled = !config.isConfigured;
          }
        }

        async function quickRefreshUSGSOnly() {
          if (guestLiveDataCapped) return;
          if (!config.isConfigured || !config.locations.length) return;
          await refreshWeather();
        }

        setInterval(() => {
          void quickRefreshUSGSOnly();
        }, 5 * 60 * 1000);

        async function quickRefreshNonUSGS() {
          if (guestLiveDataCapped) return;
          if (!config.isConfigured || !config.locations.length) return;
          await withGuestLiveBundle(() =>
            Promise.all([refreshNoaa(), refreshCyclones(), refreshWildfires(), refreshForecasts()])
          );
        }

        setInterval(() => {
          void quickRefreshNonUSGS();
        }, 30 * 60 * 1000);

        if (typeof window !== 'undefined') {
          try {
            Object.assign(window, {
              addLocation,
              removeLocation,
              completeSetup,
              refreshNoaa,
              refreshWeather,
              refreshCyclones,
              refreshWildfires,
              refreshForecasts,
              showPage,
              toggleNavDrawer,
              closeNavDrawer,
              toggleOpenAtLogin,
              openRootRecordWebsite,
              emailRootRecordSupport,
              openDiscordSupport,
              authSignIn,
              authSignUp,
              authContinueWithoutAccount,
              startCheckout,
              onUnitSystemChanged,
              saveAlertSettings,
              openLocationMapPicker,
              closeLocationMapPicker,
              applyPickedLocation,
              openDashboardDetail,
              closeDashboardDetail,
              openEventDetail,
              openExternalUrl,
              previewSelectedAlertSound,
              refreshBackupPanel,
              saveBackupSettings,
              backupDatabaseNow,
              openBackupFolder,
              humanizeLicenseGateError,
              authLogout,
              refreshAllDataFromSettings
            });
          } catch (error) {
            setAuthStatus('error', 'UI initialization failed: ' + (error && error.message ? error.message : String(error)));
          }
        }

        (function bindAuthGateControls() {
          console.log('[rrwm] binding auth gate controls');
          function dispatch(id) {
            console.log('[rrwm] auth click:', id);
            try {
              if (id === 'authSignInBtn') return void authSignIn();
              if (id === 'authSignUpBtn') return void authSignUp();
              if (id === 'authContinueLocalBtn') return void authContinueWithoutAccount();
              if (id === 'authSubscribeBtn') return void startCheckout();
              if (id === 'authOpenWebsiteBtn') return void openRootRecordWebsite();
            } catch (e) {
              console.error('[rrwm] auth handler threw', e);
              setAuthStatus('error', 'Auth handler error: ' + (e && e.message ? e.message : String(e)));
            }
          }
          const ids = ['authSignInBtn', 'authSignUpBtn', 'authContinueLocalBtn', 'authSubscribeBtn', 'authOpenWebsiteBtn'];
          for (let i = 0; i < ids.length; i += 1) {
            const id = ids[i];
            const el = document.getElementById(id);
            if (!el) {
              console.warn('[rrwm] missing element', id);
              continue;
            }
            el.onclick = function (ev) {
              if (ev) {
                ev.preventDefault();
                ev.stopPropagation();
              }
              dispatch(id);
            };
          }
          document.addEventListener(
            'click',
            function (ev) {
              const t = ev && ev.target;
              if (!t || typeof t.closest !== 'function') return;
              const btn = t.closest('button');
              if (!btn) return;
              if (ids.indexOf(btn.id) === -1) return;
              ev.preventDefault();
              ev.stopPropagation();
              dispatch(btn.id);
            },
            true
          );
          const pwd = document.getElementById('authPassword');
          if (pwd) {
            pwd.addEventListener('keydown', function (ev) {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                dispatch('authSignInBtn');
              }
            });
          }
        })();

        wireHtmlOnclickAttributes(document);
        void initializeAuthGate();
      </script>
    </body>
    </html>
  `;
  const runtimeUiPath = path.join(app.getPath('userData'), 'rrwm-runtime-ui.html');
  fs.writeFileSync(runtimeUiPath, appHtml, 'utf8');
  mainWindow.loadFile(runtimeUiPath);
  mainWindow.webContents.on('did-finish-load', () => {
    const fallbackScript = `
      (() => {
        if (window.__rrwmFallbackWired) return;
        window.__rrwmFallbackWired = true;
        const pages = ['weather', 'earthquakes', 'cyclones', 'wildfires', 'settings', 'about', 'contact'];
        const fallbackShowPage = (pageName) => {
          for (const p of pages) {
            const el = document.getElementById(p + '-page');
            if (el) el.style.display = p === pageName ? 'block' : 'none';
          }
        };
        if (typeof window.showPage !== 'function') {
          window.showPage = fallbackShowPage;
        }
        function rrwmClosestButton(ev) {
          const t = ev && ev.target;
          if (!t) return null;
          if (typeof t.closest === 'function') return t.closest('button');
          return t.parentElement && typeof t.parentElement.closest === 'function'
            ? t.parentElement.closest('button')
            : null;
        }
        document.addEventListener('click', (event) => {
          const t = event && event.target;
          if (t && typeof t.closest === 'function' && t.closest('#authGate')) return;
          const btn = rrwmClosestButton(event);
          if (!btn) return;
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'weather' || text === 'weather (noaa)') fallbackShowPage('weather');
          if (text === 'earthquakes & tsunamis') fallbackShowPage('earthquakes');
          if (text === 'cyclone tracker') fallbackShowPage('cyclones');
          if (text === 'wildfires') fallbackShowPage('wildfires');
          if (text === 'settings') fallbackShowPage('settings');
          if (text === 'about / coverage') fallbackShowPage('about');
          if (text === 'contact & feedback') fallbackShowPage('contact');
        }, true);
      })();
    `;
    void mainWindow.webContents.executeJavaScript(fallbackScript).catch(() => {});
  });

  /* DevTools and verbose renderer logging only when launched with --dev (see npm run dev). */
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['V', 'I', 'W', 'E'][level] || '?';
      process.stdout.write(`[renderer ${tag}] ${message} (${sourceId}:${line})\n`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      process.stdout.write(`[renderer GONE] reason=${details.reason} exitCode=${details.exitCode}\n`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      process.stdout.write(`[renderer FAIL] ${code} ${desc} url=${url}\n`);
    });
  }
}

app.whenReady().then(() => {
  migrateLegacyStoreAuthToLicenseSessionOnce();
  initLocalDatabase();
  applyOpenAtLoginSetting();
  startWeatherBackupMaintenance();
  createWindow();
  setupAutoUpdater(app, getMainWindow);
  setInterval(() => {
    weatherSync.syncCycleBestEffort().catch(() => {});
  }, 4 * 60 * 1000);
});

app.on('window-all-closed', () => {
  if (db) db.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('get-location-config', async () => {
  return readLocationConfig();
});

ipcMain.handle('weather-check-for-updates', async () => checkForUpdatesInteractive(app, getMainWindow));

ipcMain.handle('save-location-config', async (_event, config) => {
  const existing = readLocationConfig();
  const pro = licenseService.proFeaturesUnlocked();
  const radius = Number(config && config.radiusMiles);
  const unitSystem = String(config && config.unitSystem ? config.unitSystem : '').toLowerCase() === 'metric' ? 'metric' : 'imperial';
  const alertsRaw =
    pro && config && config.criticalAlerts && typeof config.criticalAlerts === 'object'
      ? config.criticalAlerts
      : existing.criticalAlerts;
  const alerts = alertsRaw && typeof alertsRaw === 'object' ? alertsRaw : {};
  const usgsMinMagnitude = Number(alerts.usgsMinMagnitude);
  const usgsMaxDistanceMiles = Number(alerts.usgsMaxDistanceMiles);
  const soundPath = String(alerts.soundPath || '').trim();
  const next = {
    isConfigured: Boolean(config && config.isConfigured),
    radiusMiles: Number.isFinite(radius) && radius > 0 ? radius : 150,
    unitSystem,
    criticalAlerts: {
      weatherEnabled: alerts.weatherEnabled !== false,
      usgsEnabled: alerts.usgsEnabled !== false,
      usgsMinMagnitude: Number.isFinite(usgsMinMagnitude) ? Math.max(0, usgsMinMagnitude) : 5.0,
      usgsMaxDistanceMiles: Number.isFinite(usgsMaxDistanceMiles) && usgsMaxDistanceMiles > 0 ? usgsMaxDistanceMiles : 200,
      soundPath
    },
    locations: Array.isArray(config && config.locations) ? config.locations : []
  };
  store.set(LOCATION_CONFIG_KEY, next);
  return readLocationConfig();
});

function ensureConfigured() {
  const cfg = readLocationConfig();
  if (!cfg.isConfigured || !cfg.locations.length) {
    throw new Error('Location setup is incomplete. Configure and finalize setup first.');
  }
  return cfg;
}

ipcMain.handle('archive-noaa', async (_event, items) => {
  appendArchive('noaa', items);
  return { ok: true };
});

ipcMain.handle('archive-usgs', async (_event, items) => {
  appendArchive('usgs', items);
  return { ok: true };
});

ipcMain.handle('archive-canada', async (_event, items) => {
  appendArchive('canada', items);
  return { ok: true };
});

ipcMain.handle('archive-tsunamis', async (_event, items) => {
  appendArchive('tsunamis', items);
  return { ok: true };
});

ipcMain.handle('archive-noaa-dashboard', async (_event, items) => {
  appendArchive('noaaDashboard', items);
  return { ok: true };
});

ipcMain.handle('archive-cyclones', async (_event, items) => {
  appendArchive('cyclones', items);
  return { ok: true };
});

ipcMain.handle('archive-wildfires', async (_event, items) => {
  appendArchive('wildfires', items);
  return { ok: true };
});

ipcMain.handle('archive-forecasts', async (_event, items) => {
  appendArchive('forecasts', items);
  return { ok: true };
});

ipcMain.handle('store-records', async (_event, payload) => {
  const p = payload || {};
  const records = Array.isArray(p.records) ? p.records : [];
  const meta = {
    source: p.source || 'unknown',
    category: p.category || 'general',
    isForecast: Boolean(p.isForecast)
  };
  const job = storeRecordsQueue.then(() => storeRecords(records, meta));
  storeRecordsQueue = job.catch((err) => {
    console.error('RootRecord Weather Manager: store-records failed:', err);
  });
  await job;
  return { ok: true, count: records.length };
});

ipcMain.handle('archive-summary', async () => {
  const archive = readArchive();
  return {
    noaa: archive.noaa.length,
    canada: archive.canada.length,
    usgs: archive.usgs.length,
    tsunamis: archive.tsunamis.length,
    noaaDashboard: archive.noaaDashboard.length,
    cyclones: archive.cyclones.length,
    wildfires: archive.wildfires.length,
    forecasts: archive.forecasts.length
  };
});

ipcMain.handle('archive-latest', async (_event, options) => {
  const archive = readArchive();
  const countRaw = Number(options && options.count);
  const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(1000, Math.floor(countRaw)) : 250;
  const pull = (arr) => (Array.isArray(arr) ? arr.slice(-count).map((entry) => entry && entry.payload).filter(Boolean) : []);
  /** USGS payloads are time-sorted newest-first; legacy archives may mix orders — always return newest by event time. */
  const pullUsgs = (arr) => {
    if (!Array.isArray(arr)) return [];
    const payloads = arr.map((entry) => entry && entry.payload).filter(Boolean);
    payloads.sort((a, b) => (Number(b.timeMs) || 0) - (Number(a.timeMs) || 0));
    return payloads.slice(0, count);
  };
  const dashboardRows = pull(archive.noaaDashboard);
  return {
    noaa: pull(archive.noaa),
    canada: pull(archive.canada),
    usgs: pullUsgs(archive.usgs),
    tsunamis: pull(archive.tsunamis),
    noaaDashboard: dashboardRows.length ? dashboardRows[dashboardRows.length - 1] : null,
    cyclones: pull(archive.cyclones),
    wildfires: pull(archive.wildfires),
    forecasts: pull(archive.forecasts)
  };
});

ipcMain.handle('show-critical-popup', async (_event, payload) => {
  createOrShowCriticalPopup(payload);
  return { ok: true };
});

ipcMain.handle('fetch-noaa-alerts', async () => {
  ensureConfigured();
  assertGuestPublicDataFetchAllowed();
  const response = await fetch('https://api.weather.gov/alerts/active', {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (root@rootrecord.info)',
      'Accept': 'application/geo+json'
    }
  });
  if (!response.ok) {
    throw new Error(`U.S. weather alerts request failed: ${response.status}`);
  }
  return await response.json();
});

ipcMain.handle('fetch-canada-alerts', async () => {
  ensureConfigured();
  assertGuestPublicDataFetchAllowed();
  const response = await fetch('https://api.weather.gc.ca/collections/weather-alerts/items?f=json');
  if (!response.ok) {
    throw new Error(`Canada weather alerts request failed: ${response.status}`);
  }
  return await response.json();
});

ipcMain.handle('fetch-usgs-events', async (_event, box) => {
  ensureConfigured();
  assertGuestPublicDataFetchAllowed();
  const now = Date.now();
  const params = new URLSearchParams({
    format: 'geojson',
    endtime: new Date(now).toISOString(),
    starttime: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    // USGS default orderby=time is ascending; with a high limit we only got the *oldest* events first.
    // Newest-first + a 30-day window keeps responses smaller and avoids timeouts / HTTP errors.
    orderby: 'time-desc',
    limit: '800',
    minlatitude: String(box && box.minLat != null ? box.minLat : -90),
    maxlatitude: String(box && box.maxLat != null ? box.maxLat : 90),
    minlongitude: String(box && box.minLon != null ? box.minLon : -180),
    maxlongitude: String(box && box.maxLon != null ? box.maxLon : 180)
  });
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/geo+json, application/json',
      'User-Agent': 'RootRecordWeatherManager/1.0 (root@rootrecord.info)'
    }
  });
  const bodyText = await response.text();
  if (!response.ok) {
    if (response.status === 400) {
      // Bad request (e.g. invalid bbox) — do not surface as a blocking dialog; return empty quake list.
      return { type: 'FeatureCollection', features: [] };
    }
    const hint = bodyText && bodyText.length < 400 ? ` — ${bodyText.trim()}` : '';
    throw new Error(`USGS request failed: ${response.status} ${response.statusText || ''}${hint}`);
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error('USGS returned invalid JSON');
  }
  const meta = data && data.metadata;
  if (meta && Number(meta.status) >= 400) {
    if (Number(meta.status) === 400) {
      return { type: 'FeatureCollection', features: [] };
    }
    throw new Error(String(meta.title || `USGS query error (${meta.status})`));
  }
  return data;
});

ipcMain.handle('fetch-noaa-forecast', async (_event, coords) => {
  ensureConfigured();
  const latitude = Number(coords && coords.latitude);
  const longitude = Number(coords && coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Invalid coordinates for forecast request');
  }
  const pointsResponse = await fetch(`https://api.weather.gov/points/${latitude},${longitude}`, {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (root@rootrecord.info)',
      'Accept': 'application/geo+json'
    }
  });
  if (!pointsResponse.ok) {
    throw new Error(`Weather grid lookup failed: ${pointsResponse.status}`);
  }
  const points = await pointsResponse.json();
  const forecastUrl = points && points.properties ? points.properties.forecast : null;
  if (!forecastUrl) {
    throw new Error('Forecast endpoint not available for this location');
  }
  const forecastResponse = await fetch(forecastUrl, {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (root@rootrecord.info)',
      'Accept': 'application/geo+json'
    }
  });
  if (!forecastResponse.ok) {
    throw new Error(`Forecast request failed: ${forecastResponse.status}`);
  }
  return await forecastResponse.json();
});

async function fetchNoaaJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'RootRecordWeatherManager/1.0 (root@rootrecord.info)',
      'Accept': 'application/geo+json'
    }
  });
  if (!response.ok) {
    throw new Error(`Weather data request failed: ${response.status}`);
  }
  return await response.json();
}

ipcMain.handle('fetch-noaa-dashboard', async (_event, payload) => {
  ensureConfigured();
  const locations = Array.isArray(payload && payload.locations) ? payload.locations : [];
  if (locations.length) assertGuestPublicDataFetchAllowed();
  const current = [];
  const daily = [];
  const averages = [];
  const radar = [];
  const satellite = [
    { label: 'GOES East - CONUS Geocolor', url: 'https://cdn.star.nesdis.noaa.gov/GOES16/ABI/CONUS/GEOCOLOR/latest.jpg' },
    { label: 'GOES West - CONUS Geocolor', url: 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/CONUS/GEOCOLOR/latest.jpg' }
  ];

  for (const loc of locations) {
    const latitude = Number(loc.latitude);
    const longitude = Number(loc.longitude);
    const locationName = String(loc.name || 'Location');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    try {
      const points = await fetchNoaaJson(`https://api.weather.gov/points/${latitude},${longitude}`);
      const props = points && points.properties ? points.properties : {};

      if (props.forecast) {
        const forecast = await fetchNoaaJson(props.forecast);
        const periods = forecast && forecast.properties && Array.isArray(forecast.properties.periods)
          ? forecast.properties.periods
          : [];
        const first = periods[0];
        if (first) {
          daily.push({
            locationName,
            name: first.name || 'Period',
            shortForecast: first.shortForecast || '',
            temperature: first.temperature,
            temperatureUnit: first.temperatureUnit
          });
        }
      }

      if (props.radarStation) {
        const station = String(props.radarStation || '').trim().toUpperCase();
        if (station) {
          radar.push({
            locationName,
            station,
            url: `https://radar.weather.gov/ridge/standard/${station}_loop.gif`
          });
        }
      }

      if (props.forecastHourly) {
        const hourly = await fetchNoaaJson(props.forecastHourly);
        const periods = hourly && hourly.properties && Array.isArray(hourly.properties.periods)
          ? hourly.properties.periods
          : [];
        const now = new Date();
        const next24 = periods.filter((p) => p && p.startTime && (new Date(p.startTime) > now)).slice(0, 24);
        if (next24.length) {
          const tempVals = next24.map((p) => Number(p.temperature)).filter((n) => Number.isFinite(n));
          const windVals = next24
            .map((p) => Number(String(p.windSpeed || '').split(' ')[0]))
            .filter((n) => Number.isFinite(n));
          const avgTemp = tempVals.length ? tempVals.reduce((a, b) => a + b, 0) / tempVals.length : null;
          const avgWind = windVals.length ? windVals.reduce((a, b) => a + b, 0) / windVals.length : null;
          const first = next24[0];
          current.push({
            locationName,
            text: first.shortForecast || '',
            temperatureF: first.temperature,
            windMph: first.windSpeed || ''
          });
          averages.push({
            locationName,
            avgTempF: avgTemp !== null ? avgTemp.toFixed(1) : 'n/a',
            avgWindMph: avgWind !== null ? avgWind.toFixed(1) : 'n/a'
          });
        }
      } else if (props.observationStations) {
        const stations = await fetchNoaaJson(props.observationStations);
        const stationList = Array.isArray(stations && stations.features) ? stations.features : [];
        const stationId = stationList[0] && stationList[0].properties ? stationList[0].properties.stationIdentifier : null;
        if (stationId) {
          const latest = await fetchNoaaJson(`https://api.weather.gov/stations/${stationId}/observations/latest`);
          const lp = latest && latest.properties ? latest.properties : {};
          const tempC = lp.temperature && lp.temperature.value != null ? Number(lp.temperature.value) : null;
          const windMps = lp.windSpeed && lp.windSpeed.value != null ? Number(lp.windSpeed.value) : null;
          const tempF = tempC !== null && Number.isFinite(tempC) ? ((tempC * 9) / 5 + 32).toFixed(1) : 'n/a';
          const windMph = windMps !== null && Number.isFinite(windMps) ? (windMps * 2.23694).toFixed(1) : 'n/a';
          current.push({
            locationName,
            text: lp.textDescription || '',
            temperatureF: tempF,
            windMph: windMph
          });
        }
      }
    } catch {
      // Keep dashboard resilient per-location.
    }
  }

  return { current, daily, averages, radar, satellite };
});

function extractTagValue(block, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = String(block || '').match(regex);
  if (!match) return '';
  return match[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, '').replace(/<[^>]+>/g, '').trim();
}

ipcMain.handle('fetch-tsunami-bulletins', async () => {
  ensureConfigured();
  assertGuestPublicDataFetchAllowed();
  const response = await fetch('https://www.tsunami.gov/events/xml/PAAQAtom.xml');
  if (!response.ok) {
    if (response.status === 400) {
      return { entries: [] };
    }
    throw new Error(`Tsunami bulletin request failed: ${response.status}`);
  }
  const xml = await response.text();
  const entries = [];
  const blocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks.slice(0, 30)) {
    entries.push({
      title: extractTagValue(block, 'title'),
      summary: extractTagValue(block, 'summary'),
      updated: extractTagValue(block, 'updated'),
      published: extractTagValue(block, 'published')
    });
  }
  return { entries };
});

async function fetchEonetCategory(categoryId) {
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=${encodeURIComponent(categoryId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`EONET request failed: ${response.status}`);
  }
  const json = await response.json();
  const events = Array.isArray(json.events) ? json.events : [];
  return {
    items: events.slice(0, 60).map((event) => ({
      id: event.id,
      title: event.title,
      source: Array.isArray(event.sources) && event.sources[0] ? event.sources[0].url : '',
      geometryDate: Array.isArray(event.geometry) && event.geometry[0] ? event.geometry[0].date : ''
    }))
  };
}

ipcMain.handle('fetch-cyclones', async () => {
  ensureConfigured();
  assertGuestPublicDataFetchAllowed();
  return await fetchEonetCategory('severeStorms');
});

ipcMain.handle('fetch-wildfires', async () => {
  ensureConfigured();
  assertGuestPublicDataFetchAllowed();
  return await fetchEonetCategory('wildfires');
});

ipcMain.handle('weather-guest-live-refresh-cycle-complete', async () => {
  commitGuestLiveRefreshCycle();
  return { ok: true };
});

/** One call per refresh before looping `fetch-noaa-forecast` (guest throttling opens a burst window once). */
ipcMain.handle('weather-guest-begin-live-data-burst', async () => {
  assertGuestPublicDataFetchAllowed();
  return { ok: true };
});

ipcMain.handle('get-open-at-login', async () => {
  return Boolean(store.get(OPEN_AT_LOGIN_KEY, false));
});

ipcMain.handle('set-open-at-login', async (_event, enabled) => {
  store.set(OPEN_AT_LOGIN_KEY, Boolean(enabled));
  applyOpenAtLoginSetting();
  return { ok: true, openAtLogin: Boolean(store.get(OPEN_AT_LOGIN_KEY, false)) };
});

ipcMain.handle('core-auth-continue-without-account', async () => {
  try {
    await licenseService.logout();
  } catch {
    /* ignore */
  }
  wxGuestLocalSession = true;
  resetGuestPublicDataThrottleState();
  return { ok: true };
});

ipcMain.handle('core-auth-state', async () => {
  try {
    return await weatherAuthStateFromLicense();
  } catch (e) {
    const sess = licenseService.loadSession();
    const email = sess && sess.email ? String(sess.email) : '';
    if (sess && sess.access_token) {
      return {
        authenticated: true,
        email,
        message: 'Signed in. Subscription check unavailable right now.',
        entitlement: {
          allow: true,
          access: 'unknown',
          reason: 'service_unavailable',
          trialRemaining: '',
          proUnlocked: licenseService.proFeaturesUnlocked()
        }
      };
    }
    return {
      authenticated: false,
      email,
      message: String((e && e.message) || 'Auth check failed.'),
      entitlement: null
    };
  }
});

ipcMain.handle('core-auth-login', async (_event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const email = String(p.email || '').trim();
  const password = String(p.password || '');
  if (!email) throw new Error('Account is required. Please login or create an account.');
  if (!password || password.length < 10) throw new Error('Password must be at least 10 characters.');
  await licenseService.login(email, password);
  wxGuestLocalSession = false;
  resetGuestPublicDataThrottleState();
  try {
    weatherSync.scheduleSync();
    const snap = await weatherPostLoginSnapshot();
    return snap;
  } catch {
    return {
      ok: true,
      email,
      entitlement: {
        allow: true,
        access: 'unknown',
        reason: 'service_unavailable',
        trialRemaining: '',
        proUnlocked: licenseService.proFeaturesUnlocked()
      }
    };
  }
});

ipcMain.handle('core-auth-signup', async (_event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const email = String(p.email || '').trim();
  const password = String(p.password || '');
  if (!email) throw new Error('Account is required. Please login or create an account.');
  if (!password || password.length < 10) throw new Error('Password must be at least 10 characters.');
  await licenseService.signup(email, password);
  wxGuestLocalSession = false;
  resetGuestPublicDataThrottleState();
  try {
    weatherSync.scheduleSync();
    const snap = await weatherPostLoginSnapshot();
    return snap;
  } catch {
    return {
      ok: true,
      email,
      entitlement: {
        allow: true,
        access: 'unknown',
        reason: 'service_unavailable',
        trialRemaining: '',
        proUnlocked: licenseService.proFeaturesUnlocked()
      }
    };
  }
});

ipcMain.handle('core-auth-checkout', async () => {
  const sess = licenseService.loadSession();
  const email = String((sess && sess.email) || '').trim();
  const token = String((sess && sess.access_token) || '').trim();
  if (!email) throw new Error('Sign in required before checkout.');
  const body = await coreApiJson('/v1/billing/checkout', { email }, token);
  const url = String(body.url || '').trim();
  if (!url.startsWith('http')) {
    throw new Error('Checkout URL unavailable.');
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('core-auth-logout', async () => {
  wxGuestLocalSession = false;
  resetGuestPublicDataThrottleState();
  await licenseService.logout();
  return { ok: true };
});

ipcMain.handle('license-prepare', async (_event, payload) => {
  return licenseService.prepare(payload && typeof payload === 'object' ? payload : {});
});

ipcMain.handle('license-login', async (_event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  return licenseService.login(String(p.email || '').trim(), String(p.password || ''));
});

ipcMain.handle('license-signup', async (_event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  return licenseService.signup(String(p.email || '').trim(), String(p.password || ''));
});

ipcMain.handle('license-logout', async () => {
  return licenseService.logout();
});

ipcMain.handle('open-external-url', async (_event, urlInput) => {
  const url = String(urlInput || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Invalid URL');
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('backup-get-state', async () => {
  return {
    settings: cloudBackup.readSettings(store),
    backupsDir: weatherBackupsDir()
  };
});

ipcMain.handle('backup-save-settings', async (_event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  const cur = cloudBackup.readSettings(store);
  const next = {
    ...cur,
    cloud_backup_enabled: false,
    cloud_backup_api_base_url: '',
    auto_backup_enabled: Boolean(p.auto_backup_enabled),
    auto_backup_interval_hours: Math.max(1, parseInt(String(p.auto_backup_interval_hours || 24), 10) || 24)
  };
  cloudBackup.writeSettings(store, next);
  return { ok: true, settings: cloudBackup.readSettings(store) };
});

ipcMain.handle('backup-now', async (_event, reason) => {
  return weatherRunLocalBackup(String(reason || 'manual'));
});

ipcMain.handle('backup-open-folder', async () => {
  const dir = weatherBackupsDir();
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('get-alert-sounds', async () => {
  try {
    const allowed = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
    const byName = new Map();
    for (const dir of getAlertSoundScanDirs()) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!allowed.has(ext)) continue;
        if (byName.has(entry.name)) continue;
        byName.set(entry.name, path.join(dir, entry.name));
      }
    }
    return [...byName.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, fullPath]) => ({ name, path: fullPath }));
  } catch {
    return [];
  }
});

ipcMain.handle('open-rootrecord-website', async () => {
  await shell.openExternal('https://rootrecord.com');
  return { ok: true };
});

ipcMain.handle('email-rootrecord-support', async () => {
  await shell.openExternal('mailto:root@rootrecord.info');
  return { ok: true };
});

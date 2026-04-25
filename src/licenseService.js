'use strict';

/**
 * RootRecord license API — aligns with legacy Python `license_client.py` / `license_config.py`
 * and Cloudflare Worker routes: POST /v1/auth/login, POST /v1/entitlement, GET /v1/me, POST /v1/auth/logout.
 */

const dns = require('dns');
try {
  if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
} catch {
  /* ignore */
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/** Shipped default; keep in sync with Root Record Business Manager `src/main/licenseService.js`. */
const SHIPPED_LICENSE_API_BASE_URL = 'https://rootrecord-license.wildecho94.workers.dev';

const ENTITLEMENT_CACHE_KEYS = [
  'account_id',
  'access',
  'reason',
  'trial_started_at',
  'trial_ends_at',
  'valid_until',
  'subscription_status'
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** After we first observe an active Pro subscription for an email, skip online entitlement refreshes for this many days (rolling from that anchor). */
const PRO_SIGNIN_SKIP_DAYS = 32;
const PRO_SIGNIN_SKIP_MS = PRO_SIGNIN_SKIP_DAYS * 24 * 60 * 60 * 1000;

/** Same default as classic `license_config.DEFAULT_STRIPE_PAYMENT_LINK`. Override with env `LICENSE_PAYMENT_LINK_URL`. */
const DEFAULT_STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/9B64gzaB73pb1wM7oH5gc00';

function getProStripePaymentLinkBase() {
  const u = String(process.env.LICENSE_PAYMENT_LINK_URL || '').trim();
  return u || DEFAULT_STRIPE_PAYMENT_LINK;
}

/** Merged into `prepare()` responses so the renderer can open Stripe Checkout (optional `prefilled_email`). */
function paymentLinkPayload() {
  return { proPaymentLinkBase: getProStripePaymentLinkBase() };
}

function normalizeBaseUrl(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (b.toLowerCase().endsWith('/v1')) {
    b = b.slice(0, -3).replace(/\/+$/, '');
  }
  return b;
}

/** Production API traffic must use HTTPS (policy-aligned). Allow http only to localhost for development. */
function coerceSecureLicenseApiBase(raw) {
  const s = normalizeBaseUrl(raw);
  if (!s) return normalizeBaseUrl(SHIPPED_LICENSE_API_BASE_URL);
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return s;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return s;
    console.warn(
      '[RootRecord] LICENSE_API_BASE_URL must use https:// (except http://localhost). Using default shipped API host.'
    );
    return normalizeBaseUrl(SHIPPED_LICENSE_API_BASE_URL);
  } catch {
    return normalizeBaseUrl(SHIPPED_LICENSE_API_BASE_URL);
  }
}

function getLicenseApiBaseUrl() {
  const fromEnv = normalizeBaseUrl(process.env.LICENSE_API_BASE_URL);
  if (fromEnv) return coerceSecureLicenseApiBase(fromEnv);
  return normalizeBaseUrl(SHIPPED_LICENSE_API_BASE_URL);
}

/** When true, omit LICENSE_API_SECRET client-side (frozen-build style). Not implemented for Electron dev — secret optional in env. */
function apiSecretAllowed() {
  const v = String(process.env.LICENSE_FORCE_SIGNIN_ONLY || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return false;
  return true;
}

function getApiSecret() {
  if (!apiSecretAllowed()) return '';
  return String(process.env.LICENSE_API_SECRET || '').trim();
}

function paths() {
  const root = app.getPath('userData');
  return {
    session: path.join(root, 'license_session.json'),
    entitlementCache: path.join(root, 'license_entitlement_cache.json'),
    deviceId: path.join(root, '.license_device_id'),
    /** Per-email ISO timestamp of first observed Pro (`subscription_status` active / entitlement `reason: paid`). Survives logout. */
    proFirstPaid: path.join(root, 'license_pro_first_paid.json')
  };
}

function readJsonSafe(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function loadOrCreateDeviceId() {
  const { deviceId } = paths();
  try {
    if (fs.existsSync(deviceId)) {
      const raw = fs.readFileSync(deviceId, 'utf8').trim();
      if (raw.length >= 8) return raw;
    }
  } catch {
    /* ignore */
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(deviceId), { recursive: true });
  fs.writeFileSync(deviceId, id, 'utf8');
  return id;
}

function writeEntitlementCacheFromBody(body) {
  if (!body || typeof body !== 'object') return;
  try {
    const cachePayload = {};
    for (const k of ENTITLEMENT_CACHE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, k)) cachePayload[k] = body[k];
    }
    if (Object.keys(cachePayload).length === 0) return;
    writeJsonAtomic(paths().entitlementCache, cachePayload);
  } catch {
    /* ignore */
  }
}

function loadEntitlementCache() {
  return readJsonSafe(paths().entitlementCache, null);
}

/** @returns {Record<string, string>} email lower -> first Pro observed at (ISO) */
function loadProFirstPaidMap() {
  const raw = readJsonSafe(paths().proFirstPaid, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function recordFirstProPaidAnchorIfNeeded(email, cache, me) {
  if (!isPaidSubscription(cache || {}, me || {})) return;
  const em = String(email || '').trim().toLowerCase();
  if (!em) return;
  const map = loadProFirstPaidMap();
  if (map[em]) return;
  map[em] = new Date().toISOString();
  writeJsonAtomic(paths().proFirstPaid, map);
}

/** Paid / Pro per server + last entitlement snapshot. */
function isPaidSubscription(cache, me) {
  const reason = String(cache?.reason || '');
  const sub = String(me?.subscription_status || cache?.subscription_status || '').toLowerCase();
  return reason === 'paid' || sub === 'active';
}

/**
 * While within PRO_SIGNIN_SKIP_MS of first observed Pro for this email, treat entitlement as fresh without calling the API
 * (unless forceRefresh). Reduces sign-in / subscription chatter for stable Pro users.
 */
function shouldSkipOnlineEntitlementRefresh(email, cache, me, forceRefresh) {
  if (forceRefresh) return false;
  if (!isPaidSubscription(cache || {}, me || {})) return false;
  const em = String(email || '').trim().toLowerCase();
  if (!em) return false;
  const anchorIso = loadProFirstPaidMap()[em];
  if (!anchorIso || typeof anchorIso !== 'string') return false;
  const t = Date.parse(anchorIso);
  if (Number.isNaN(t)) return false;
  return Date.now() < t + PRO_SIGNIN_SKIP_MS;
}

function clearEntitlementCache() {
  try {
    const p = paths().entitlementCache;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function loadSession() {
  return readJsonSafe(paths().session, null);
}

function saveSession(obj) {
  const p = paths().session;
  if (!obj) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
    return;
  }
  writeJsonAtomic(p, obj);
}

function bearerForEntitlement(accessToken) {
  const tok = String(accessToken || '').trim();
  if (tok) return tok;
  const secret = getApiSecret();
  if (secret) return secret;
  throw new Error('Sign-in is required.');
}

async function fetchJson(method, url, opts = {}) {
  const { headers = {}, bodyObj = null } = opts;
  const init = {
    method,
    headers: { ...headers }
  };
  if (bodyObj !== null && bodyObj !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(bodyObj);
  }
  const timeoutMs = opts.timeoutMs ?? 35000;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  init.signal = ac.signal;
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const m = e && e.message ? String(e.message) : String(e || 'fetch failed');
    const err = new Error(`Network error: ${m}`);
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(tid);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data, text };
}

function extractLicenseErrorCode(body) {
  if (!body || typeof body !== 'object') return null;
  const top = body.error;
  if (top && typeof top === 'object') {
    const inner = top.error;
    if (inner && typeof inner === 'object' && typeof inner.code === 'string') return inner.code;
    if (typeof top.code === 'string') return top.code;
  }
  return null;
}

/** Map Worker / legacy responses to stable tokens for the renderer (Electron only preserves Error.message through IPC). */
function classifyLoginFailure(status, body) {
  const code = extractLicenseErrorCode(body);
  const msgRaw = parseLicenseError(body);
  const msg = String(msgRaw || '').toLowerCase();

  if (status === 403) {
    if (code === 'PASSWORD_NOT_SET') return 'LR_AUTH_PASSWORD_NOT_SET';
  }
  if (status === 409) {
    if (code === 'DEVICE_CONFLICT') return 'LR_AUTH_DEVICE_CONFLICT';
  }
  if (status === 400) {
    if (code === 'INVALID_DEVICE_ID') return 'LR_AUTH_INVALID_DEVICE_ID';
  }

  if (status === 401) {
    if (code === 'INVALID_PASSWORD') return 'LR_AUTH_INVALID_PASSWORD';
    if (code === 'ACCOUNT_NOT_FOUND') return 'LR_AUTH_ACCOUNT_NOT_FOUND';
    if (/\bincorrect\s+password\b/.test(msgRaw) || msg.includes('incorrect password')) {
      return 'LR_AUTH_INVALID_PASSWORD';
    }
    if (/no\s+account\s+(exists|for)/i.test(msgRaw) || msg.includes('account not found')) {
      return 'LR_AUTH_ACCOUNT_NOT_FOUND';
    }
    if (
      code === 'INVALID_CREDENTIALS' ||
      /\bincorrect\s+email\s+or\s+password\b/i.test(msgRaw)
    ) {
      return 'LR_AUTH_LEGACY_AMBIGUOUS';
    }
  }

  return null;
}

function parseLicenseError(body) {
  if (!body || typeof body !== 'object') return 'Request failed.';
  const err = body.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object') {
    const inner = err.error;
    if (inner && typeof inner === 'object') {
      const msg = inner.message || inner.code;
      if (msg) return String(msg);
      if (typeof inner.code === 'string') return inner.code;
    }
    const msg = err.message || err.code;
    if (msg) return String(msg);
    if (typeof err.code === 'string') return err.code;
  }
  return 'Request failed.';
}

function workerHttpError(status, body) {
  const code = extractLicenseErrorCode(body);
  const msg = parseLicenseError(body);
  if (code && msg && msg !== 'Request failed.') return `${msg} (${code})`;
  if (code) return `[${code}] ${msg}`;
  return msg || `HTTP ${status}`;
}

async function postEntitlement(baseUrl, email, deviceId, bearerToken) {
  const url = `${baseUrl}/v1/entitlement`;
  const auth = bearerForEntitlement(bearerToken);
  const r = await fetchJson('POST', url, {
    headers: { Authorization: `Bearer ${auth}` },
    bodyObj: { email: String(email || '').trim(), device_id: deviceId }
  });
  if (r.status === 401) {
    const e = new Error(parseLicenseError(r.data) || 'Unauthorized.');
    e.code = 401;
    throw e;
  }
  if (!r.ok) {
    throw new Error(workerHttpError(r.status, r.data));
  }
  const body = r.data || {};
  writeEntitlementCacheFromBody(body);
  return body;
}

async function getMe(baseUrl, accessToken) {
  const url = `${baseUrl}/v1/me`;
  const r = await fetchJson('GET', url, {
    headers: { Authorization: `Bearer ${String(accessToken || '').trim()}` },
    bodyObj: null,
    timeoutMs: 22000
  });
  if (r.status === 401) {
    const e = new Error('Session invalid or expired.');
    e.code = 401;
    throw e;
  }
  if (!r.ok) {
    throw new Error(workerHttpError(r.status, r.data));
  }
  return r.data || {};
}

/** Pro tier (reports, multi-business, etc.): Worker sets `reason: paid` when subscription is active (see cloudflare entitlement). */
function planEntitlement(cache, me) {
  const access = String(cache?.access || '');
  const reason = String(cache?.reason || '');
  if (access !== 'full') {
    return { proUnlocked: false, planTier: 'free', planLabel: 'Free' };
  }
  if (reason === 'paid') {
    return { proUnlocked: true, planTier: 'pro', planLabel: 'Pro' };
  }
  return { proUnlocked: false, planTier: 'free', planLabel: 'Free' };
}

function membershipUi(cache, me) {
  const access = String(cache?.access || '');
  const reason = String(cache?.reason || '');
  const sub = String(me?.subscription_status || cache?.subscription_status || '').toLowerCase();
  const trialEndsAt = cache?.trial_ends_at ?? me?.trial_ends_at ?? null;
  const validUntil = cache?.valid_until ?? null;
  const plan = planEntitlement(cache, me);

  let label = 'Not signed in';
  let isPaidMember = plan.proUnlocked;
  let isTrial = false;

  if (access === 'full' && reason === 'paid') {
    label = 'Pro';
    isPaidMember = true;
  } else if (access === 'full' && reason === 'trialing') {
    label = 'Free';
    isTrial = true;
  } else if (access === 'read_only') {
    label = reason === 'past_due' ? 'Read-only (subscription past due)' : 'Read-only';
  } else if (access === 'full') {
    label = plan.planLabel === 'pro' ? 'Pro' : 'Free';
    isTrial = reason === 'trialing' || sub === 'trialing';
  }

  return {
    membershipLabel: label,
    isPaidMember,
    isTrial,
    proUnlocked: plan.proUnlocked,
    planTier: plan.planTier,
    planLabel: plan.planLabel,
    access,
    reason,
    subscriptionStatus: sub || String(me?.subscription_status || ''),
    trialEndsAt,
    validUntil,
    accountId: String(me?.account_id || cache?.account_id || ''),
    email: String(me?.email || '')
  };
}

function proFeaturesUnlocked() {
  const sess = loadSession();
  if (!sess || !sess.access_token) return false;
  const cache = loadEntitlementCache();
  return planEntitlement(cache || {}, sess.me || {}).proUnlocked;
}

async function refreshAccountSnapshot(sess) {
  const baseUrl = getLicenseApiBaseUrl();
  const deviceId = loadOrCreateDeviceId();
  await postEntitlement(baseUrl, sess.email, deviceId, sess.access_token);
  let me = null;
  try {
    me = await getMe(baseUrl, sess.access_token);
  } catch {
    me = null;
  }
  if (me && typeof me === 'object') {
    sess.me = {
      account_id: me.account_id,
      email: me.email,
      subscription_status: me.subscription_status,
      trial_started_at: me.trial_started_at,
      trial_ends_at: me.trial_ends_at,
      has_password: me.has_password
    };
    if (me.account_id) sess.account_id = String(me.account_id);
  }
  sess.last_entitlement_check_utc = new Date().toISOString();
  saveSession(sess);
  const cache = loadEntitlementCache() || {};
  recordFirstProPaidAnchorIfNeeded(sess.email, cache, sess.me || {});
  return membershipUi(cache, sess.me || {});
}

function cacheAllowsOfflineContinue() {
  const raw = loadEntitlementCache();
  if (!raw || raw.access !== 'full') return false;
  const vu = raw.valid_until;
  if (!vu || typeof vu !== 'string') return false;
  const t = Date.parse(vu.endsWith('Z') ? vu : `${vu}Z`);
  if (Number.isNaN(t)) return false;
  return Date.now() < t;
}

/**
 * @param {{ forceRefresh?: boolean }} [opts]
 * When `forceRefresh` is true, skip the weekly entitlement cache and call the license API immediately
 * (e.g. after returning from Stripe checkout or opening Account Settings).
 * Pro users skip online refreshes for PRO_SIGNIN_SKIP_DAYS after first observed Pro (see `license_pro_first_paid.json`).
 */
async function prepare(opts = {}) {
  const forceRefresh = Boolean(opts && opts.forceRefresh);
  const baseUrl = getLicenseApiBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      configured: false,
      authenticated: false,
      message: 'Online sign-in is not set up in this app. Contact support if you need help.',
      ...paymentLinkPayload()
    };
  }

  let sess = loadSession();
  if (!sess || !sess.access_token || !sess.email) {
    return {
      ok: true,
      configured: true,
      authenticated: false,
      baseUrl,
      ...paymentLinkPayload()
    };
  }

  const cachePre = loadEntitlementCache() || {};
  const skipOnlinePro = shouldSkipOnlineEntitlementRefresh(sess.email, cachePre, sess.me || {}, forceRefresh);

  const lastIso = sess.last_entitlement_check_utc;
  const last = lastIso ? Date.parse(lastIso) : 0;
  let stale = forceRefresh;
  if (!stale && skipOnlinePro) {
    stale = false;
  } else if (!stale) {
    stale = !lastIso || Date.now() - last >= WEEK_MS;
  }

  if (!stale) {
    const cache = loadEntitlementCache() || {};
    const ui = membershipUi(cache, sess.me || {});
    return {
      ok: true,
      configured: true,
      authenticated: true,
      baseUrl,
      ...ui,
      email: sess.email,
      offlineGrace: false,
      lastCheck: lastIso,
      ...paymentLinkPayload()
    };
  }

  try {
    const uiFresh = await refreshAccountSnapshot(sess);
    sess = loadSession();
    return {
      ok: true,
      configured: true,
      authenticated: true,
      baseUrl,
      ...uiFresh,
      email: sess.email,
      offlineGrace: false,
      lastCheck: sess.last_entitlement_check_utc,
      ...paymentLinkPayload()
    };
  } catch (e) {
    if (e && e.code === 401) {
      saveSession(null);
      clearEntitlementCache();
      return {
        ok: true,
        configured: true,
        authenticated: false,
        baseUrl,
        message: e.message || 'Session expired. Sign in again.',
        ...paymentLinkPayload()
      };
    }

    const cache = loadEntitlementCache() || {};
    if (cacheAllowsOfflineContinue()) {
      const ui = membershipUi(cache, sess.me || {});
      return {
        ok: true,
        configured: true,
        authenticated: true,
        baseUrl,
        ...ui,
        email: sess.email,
        offlineGrace: true,
        warning: String(e.message || 'Could not reach subscription service.'),
        lastCheck: lastIso || null,
        ...paymentLinkPayload()
      };
    }

    return {
      ok: false,
      configured: true,
      authenticated: false,
      baseUrl,
      message: String(e.message || 'Could not verify subscription.'),
      ...paymentLinkPayload()
    };
  }
}

async function persistAuthResponse(emailTrimmed, body) {
  const baseUrl = getLicenseApiBaseUrl();
  const token = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  if (!token) throw new Error('Server did not return a session token.');
  writeEntitlementCacheFromBody(body);

  const sess = {
    access_token: token,
    email: emailTrimmed,
    account_id: body.account_id ? String(body.account_id) : '',
    me: null,
    last_entitlement_check_utc: null
  };
  saveSession(sess);
  await refreshAccountSnapshot(loadSession());
  const sess2 = loadSession();
  const cache = loadEntitlementCache() || {};
  const ui = membershipUi(cache, sess2.me || {});
  return {
    ok: true,
    authenticated: true,
    ...ui,
    email: sess2.email,
    baseUrl,
    lastCheck: sess2.last_entitlement_check_utc
  };
}

async function login(email, password) {
  const baseUrl = getLicenseApiBaseUrl();
  if (!baseUrl) throw new Error('Online sign-in is not set up in this app. Contact support if you need help.');
  const deviceId = loadOrCreateDeviceId();
  const url = `${baseUrl}/v1/auth/login`;
  const r = await fetchJson(
    'POST',
    url,
    {
      bodyObj: {
        email: String(email || '').trim(),
        password: String(password || ''),
        device_id: deviceId
      },
      timeoutMs: 40000
    }
  );

  if (r.status >= 400) {
    const token = classifyLoginFailure(r.status, r.data);
    if (token) throw new Error(token);
    throw new Error(workerHttpError(r.status, r.data));
  }

  return persistAuthResponse(String(email || '').trim(), r.data || {});
}

/** POST /v1/auth/signup — same payload as login. */
async function signup(email, password) {
  const baseUrl = getLicenseApiBaseUrl();
  if (!baseUrl) throw new Error('Online sign-in is not set up in this app. Contact support if you need help.');
  const deviceId = loadOrCreateDeviceId();
  const url = `${baseUrl}/v1/auth/signup`;
  const r = await fetchJson(
    'POST',
    url,
    {
      bodyObj: {
        email: String(email || '').trim(),
        password: String(password || ''),
        device_id: deviceId
      },
      timeoutMs: 40000
    }
  );

  if (r.status === 409) {
    throw new Error(parseLicenseError(r.data) || 'That email may already be registered. Try signing in instead.');
  }
  if (r.status >= 400) {
    throw new Error(parseLicenseError(r.data) || `Could not create account (${r.status}).`);
  }

  return persistAuthResponse(String(email || '').trim(), r.data || {});
}

/** Remove all sync events for this account on the license Worker (USER_DATA_DB). Requires a valid session. */
async function deleteCloudSyncData() {
  const baseUrl = getLicenseApiBaseUrl();
  if (!baseUrl) throw new Error('Online sign-in is not set up in this app. Contact support if you need help.');
  const sess = loadSession();
  const tok = sess && sess.access_token ? String(sess.access_token).trim() : '';
  if (!tok) throw new Error('Sign in to manage cloud sync data.');
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/sync/clear`;
  const r = await fetchJson('POST', url, {
    headers: { Authorization: `Bearer ${tok}` },
    bodyObj: {},
    timeoutMs: 45000
  });
  if (r.status === 401) {
    const e = new Error('Session expired. Sign in again.');
    e.code = 401;
    throw e;
  }
  if (!r.ok) throw new Error(workerHttpError(r.status, r.data));
  return r.data && typeof r.data === 'object' ? r.data : { ok: true };
}

async function logout() {
  const baseUrl = getLicenseApiBaseUrl();
  const sess = loadSession();
  const tok = sess && sess.access_token ? String(sess.access_token).trim() : '';
  if (tok && baseUrl) {
    try {
      const url = `${baseUrl}/v1/auth/logout`;
      await fetchJson(
        'POST',
        url,
        {
          headers: { Authorization: `Bearer ${tok}` },
          bodyObj: null,
          timeoutMs: 18000
        }
      );
    } catch {
      /* offline or already invalid */
    }
  }
  saveSession(null);
  clearEntitlementCache();
  return { ok: true };
}

module.exports = {
  prepare,
  login,
  signup,
  logout,
  deleteCloudSyncData,
  getLicenseApiBaseUrl,
  getProStripePaymentLinkBase,
  loadSession,
  loadOrCreateDeviceId,
  proFeaturesUnlocked,
  SHIPPED_LICENSE_API_BASE_URL
};

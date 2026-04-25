import axios from 'axios';

const BACKEND = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND}/api`;

const STORAGE_KEYS = {
  token: 'rrwm.token',
  email: 'rrwm.email',
  guest: 'rrwm.guestId',
  pro: 'rrwm.pro',
  units: 'rrwm.units',
  activeLocId: 'rrwm.activeLocationId',
};

function ensureGuestId() {
  let g = localStorage.getItem(STORAGE_KEYS.guest);
  if (!g) {
    g = 'g_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem(STORAGE_KEYS.guest, g);
  }
  return g;
}

function authHeaders() {
  const token = localStorage.getItem(STORAGE_KEYS.token);
  if (token) return { Authorization: `Bearer ${token}` };
  return { 'X-Guest-Id': ensureGuestId() };
}

const client = axios.create({ baseURL: API, timeout: 25000 });
client.interceptors.request.use((cfg) => {
  cfg.headers = { ...(cfg.headers || {}), ...authHeaders() };
  return cfg;
});

export const session = {
  getToken: () => localStorage.getItem(STORAGE_KEYS.token),
  getEmail: () => localStorage.getItem(STORAGE_KEYS.email) || '',
  isAuthed: () => Boolean(localStorage.getItem(STORAGE_KEYS.token)),
  isGuest: () => !localStorage.getItem(STORAGE_KEYS.token),
  isPro: () => localStorage.getItem(STORAGE_KEYS.pro) === '1',
  setSession: (token, email, pro) => {
    localStorage.setItem(STORAGE_KEYS.token, token || '');
    localStorage.setItem(STORAGE_KEYS.email, email || '');
    localStorage.setItem(STORAGE_KEYS.pro, pro ? '1' : '0');
  },
  clearSession: () => {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.email);
    localStorage.removeItem(STORAGE_KEYS.pro);
  },
  guestId: ensureGuestId,
  STORAGE_KEYS,
};

export const api = {
  health: () => client.get('/health'),
  // auth
  login: (email, password) => client.post('/auth/login', { email, password }),
  signup: (email, password) => client.post('/auth/signup', { email, password }),
  me: () => client.post('/auth/me'),
  // locations
  listLocations: () => client.get('/locations'),
  createLocation: (loc) => client.post('/locations', loc),
  updateLocation: (id, patch) => client.patch(`/locations/${id}`, patch),
  deleteLocation: (id) => client.delete(`/locations/${id}`),
  // weather
  current: (lat, lon) => client.get('/weather/current', { params: { lat, lon } }),
  forecast: (lat, lon) => client.get('/weather/forecast', { params: { lat, lon } }),
  alerts: (lat, lon) => client.get('/weather/alerts', { params: { lat, lon } }),
  canada: (lat, lon) => client.get('/canada/alerts', { params: { lat, lon } }),
  dashboard: (lat, lon) => client.get('/dashboard', { params: { lat, lon } }),
  // hazards
  earthquakes: (lat, lon, opts = {}) =>
    client.get('/usgs/earthquakes', {
      params: { lat, lon, period: opts.period || 'day', min_magnitude: opts.min ?? 2.5, radius_miles: opts.radius ?? 2000 },
    }),
  tsunamis: () => client.get('/usgs/tsunamis'),
  cyclones: () => client.get('/eonet/cyclones'),
  wildfires: () => client.get('/eonet/wildfires'),
};

export default client;

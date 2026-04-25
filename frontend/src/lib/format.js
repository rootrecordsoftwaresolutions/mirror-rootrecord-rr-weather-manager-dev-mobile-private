// Small formatting + unit helpers for the mobile UI.

const STORAGE_UNITS_KEY = 'rrwm.units';

export function getUnits() {
  return localStorage.getItem(STORAGE_UNITS_KEY) === 'metric' ? 'metric' : 'imperial';
}
export function setUnits(u) {
  localStorage.setItem(STORAGE_UNITS_KEY, u === 'metric' ? 'metric' : 'imperial');
}

export function fmtTemp(value, fromUnit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const u = getUnits();
  let n = Number(value);
  if (fromUnit === 'C' && u === 'imperial') n = (n * 9) / 5 + 32;
  if (fromUnit === 'F' && u === 'metric') n = ((n - 32) * 5) / 9;
  return Math.round(n) + (u === 'imperial' ? '°F' : '°C');
}

export function fmtSpeedKmH(kmh) {
  if (kmh === null || kmh === undefined) return '—';
  const u = getUnits();
  if (u === 'imperial') return Math.round(kmh / 1.609) + ' mph';
  return Math.round(kmh) + ' km/h';
}

export function fmtMileOrKm(miles) {
  if (miles === null || miles === undefined) return '—';
  const u = getUnits();
  if (u === 'imperial') return miles.toFixed(0) + ' mi';
  return Math.round(miles * 1.609) + ' km';
}

export function timeAgo(timestampMs) {
  if (!timestampMs) return '—';
  const ms = Date.now() - Number(timestampMs);
  if (ms < 0) return 'soon';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function severityClass(severity) {
  const s = String(severity || '').toLowerCase();
  if (s.includes('extreme')) return { bg: 'bg-sev-extreme/15', text: 'text-sev-extreme', border: 'border-sev-extreme/40' };
  if (s.includes('severe')) return { bg: 'bg-sev-severe/15', text: 'text-sev-severe', border: 'border-sev-severe/40' };
  if (s.includes('moderate')) return { bg: 'bg-sev-moderate/15', text: 'text-sev-moderate', border: 'border-sev-moderate/40' };
  return { bg: 'bg-sev-minor/15', text: 'text-sev-minor', border: 'border-sev-minor/40' };
}

export function magnitudeColor(mag) {
  const m = Number(mag) || 0;
  if (m >= 7) return { bg: 'bg-mag-critical', text: 'text-white' };
  if (m >= 5) return { bg: 'bg-mag-high', text: 'text-black' };
  if (m >= 3) return { bg: 'bg-mag-mid', text: 'text-black' };
  return { bg: 'bg-mag-low', text: 'text-black' };
}

export function clsx(...parts) {
  return parts.filter(Boolean).join(' ');
}

// NWS observations come in standard SI units; helper to convert and round
export function fromNwsValue(unit, n) {
  if (n === null || n === undefined) return null;
  // unit looks like 'wmoUnit:degC' / 'wmoUnit:km_h-1' / 'wmoUnit:Pa' / 'wmoUnit:percent'
  return Number(n);
}

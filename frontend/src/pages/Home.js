import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, MapPin, RefreshCw, Plus, Wind, Droplets, Gauge, Sun, AlertTriangle, ArrowUpRight } from 'lucide-react';
import { api } from '../lib/api';
import { fmtTemp, fmtSpeedKmH, severityClass, formatTime, clsx } from '../lib/format';

function Bento({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-container border border-subtle p-3 flex flex-col gap-1" data-testid={`bento-${label.toLowerCase()}`}>
      <div className="flex items-center justify-between text-neutral-400">
        <Icon strokeWidth={1.5} className="w-4 h-4" />
        <span className="text-[10px] uppercase tracking-widest font-mono">{label}</span>
      </div>
      <div className="font-mono text-2xl tracking-tight text-white">{value ?? '—'}</div>
      {sub && <div className="text-xs text-neutral-500 font-mono">{sub}</div>}
    </div>
  );
}

function LocationPicker({ locations, activeId, onPick }) {
  const [open, setOpen] = useState(false);
  const active = locations.find((l) => l.id === activeId) || locations[0];
  if (!active) return null;
  return (
    <div className="relative" data-testid="location-picker">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 active:scale-95"
        data-testid="location-picker-button"
      >
        <MapPin strokeWidth={1.5} className="w-4 h-4 text-accent" />
        <span className="text-base font-medium">{active.name}</span>
        <ChevronDown strokeWidth={1.5} className="w-4 h-4 text-neutral-500" />
      </button>
      {open && (
        <div className="absolute left-0 mt-2 w-56 bg-container border border-subtle z-20 animate-fadein" data-testid="location-picker-list">
          {locations.map((l) => (
            <button
              key={l.id}
              data-testid={`location-option-${l.id}`}
              onClick={() => { onPick(l.id); setOpen(false); }}
              className={clsx(
                'flex items-center justify-between w-full text-left px-3 py-3 border-b border-subtle last:border-0 hover:bg-containerHover',
                l.id === active.id && 'text-accent'
              )}
            >
              <span>{l.name}</span>
              <span className="text-[10px] font-mono text-neutral-500">
                {l.latitude.toFixed(2)},{l.longitude.toFixed(2)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [locations, setLocations] = useState([]);
  const [activeId, setActiveId] = useState(localStorage.getItem('rrwm.activeLocationId') || '');
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');

  const loadLocations = useCallback(async () => {
    try {
      const { data } = await api.listLocations();
      setLocations(data || []);
      if (data && data.length && !data.find((d) => d.id === activeId)) {
        setActiveId(data[0].id);
        localStorage.setItem('rrwm.activeLocationId', data[0].id);
      }
    } catch (e) {
      setErr(String(e?.response?.data?.detail || e?.message || 'Failed to load locations'));
    }
  }, [activeId]);

  const loadBundle = useCallback(async (loc) => {
    if (!loc) return;
    setLoading(true);
    setErr('');
    try {
      const { data } = await api.dashboard(loc.latitude, loc.longitude);
      setBundle(data);
    } catch (e) {
      setErr(String(e?.response?.data?.detail || e?.message || 'Failed to load weather'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadLocations(); }, [loadLocations]);

  useEffect(() => {
    const loc = locations.find((l) => l.id === activeId) || locations[0];
    if (loc) loadBundle(loc);
  }, [activeId, locations, loadBundle]);

  const handleRefresh = async () => {
    const loc = locations.find((l) => l.id === activeId);
    if (!loc) return;
    setRefreshing(true);
    await loadBundle(loc);
  };

  const setActive = (id) => {
    setActiveId(id);
    localStorage.setItem('rrwm.activeLocationId', id);
  };

  if (locations.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70vh] text-center" data-testid="home-empty">
        <MapPin strokeWidth={1.5} className="w-12 h-12 text-accent mb-4" />
        <h1 className="text-2xl font-semibold mb-2">Add your first location</h1>
        <p className="text-neutral-400 max-w-xs mb-6">
          Root Record waits until you save somewhere it should care about — pick a place to begin.
        </p>
        <button
          data-testid="home-add-location-cta"
          onClick={() => navigate('/locations/new')}
          className="bg-accent hover:bg-accentHover text-white px-5 py-3 rounded-sm flex items-center gap-2 active:scale-95"
        >
          <Plus strokeWidth={1.5} className="w-4 h-4" /> Add location
        </button>
      </div>
    );
  }

  const obs = bundle?.current?.observation || {};
  const hourlyNow = bundle?.current?.hourly_now || {};
  const tempC = obs?.temperature?.value;
  const humidity = obs?.relativeHumidity?.value;
  const wind = obs?.windSpeed?.value; // km/h
  const pressurePa = obs?.barometricPressure?.value;
  const condition = hourlyNow?.shortForecast || obs?.textDescription || '—';
  const high = bundle?.forecast?.periods?.find((p) => p.isDaytime)?.temperature;
  const low = bundle?.forecast?.periods?.find((p) => !p.isDaytime)?.temperature;
  const periodUnit = bundle?.forecast?.periods?.[0]?.temperatureUnit;

  return (
    <div className="animate-fadein" data-testid="home-page">
      <header className="flex items-center justify-between p-4">
        <LocationPicker locations={locations} activeId={activeId} onPick={setActive} />
        <button
          aria-label="Refresh"
          data-testid="home-refresh-button"
          onClick={handleRefresh}
          className={clsx(
            'p-2 rounded-sm border border-subtle text-neutral-300 hover:bg-containerHover active:scale-95',
            refreshing && 'animate-spinSlow'
          )}
        >
          <RefreshCw strokeWidth={1.5} className="w-4 h-4" />
        </button>
      </header>

      <section className="px-4">
        {loading && !bundle ? (
          <div className="space-y-4">
            <div className="h-32 skeleton" />
            <div className="grid grid-cols-2 gap-3">
              {[0,1,2,3].map((i) => <div key={i} className="h-20 skeleton" />)}
            </div>
          </div>
        ) : (
          <>
            {/* Hero */}
            <div className="bg-container border border-subtle p-5 mb-4" data-testid="home-current-hero">
              <div className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 mb-2">Now</div>
              <div className="flex items-end justify-between">
                <div>
                  <div className="font-mono text-6xl leading-none tracking-tighter" data-testid="home-current-temp">
                    {tempC === undefined || tempC === null
                      ? (hourlyNow?.temperature !== undefined ? fmtTemp(hourlyNow.temperature, hourlyNow.temperatureUnit) : '—')
                      : fmtTemp(tempC, 'C')}
                  </div>
                  <div className="mt-2 text-neutral-300">{condition}</div>
                </div>
                <div className="text-right text-xs text-neutral-400 font-mono">
                  {high !== undefined && <div>HIGH <span className="text-white">{fmtTemp(high, periodUnit)}</span></div>}
                  {low !== undefined && <div>LOW <span className="text-white">{fmtTemp(low, periodUnit)}</span></div>}
                </div>
              </div>
            </div>

            {/* Bento metrics */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <Bento icon={Wind} label="Wind" value={fmtSpeedKmH(wind)} sub={obs?.windDirection?.value !== undefined && obs.windDirection.value !== null ? `${Math.round(obs.windDirection.value)}°` : ''} />
              <Bento icon={Droplets} label="Humidity" value={humidity != null ? `${Math.round(humidity)}%` : '—'} />
              <Bento icon={Gauge} label="Pressure" value={pressurePa != null ? `${(pressurePa/100).toFixed(0)} hPa` : '—'} />
              <Bento icon={Sun} label="Visibility" value={obs?.visibility?.value != null ? `${(obs.visibility.value/1000).toFixed(1)} km` : '—'} />
            </div>

            {/* Hourly */}
            {Array.isArray(bundle?.forecast?.hourly) && bundle.forecast.hourly.length > 0 && (
              <div className="mb-6">
                <h2 className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 mb-2">Next 12 hours</h2>
                <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1" data-testid="home-hourly-strip">
                  {bundle.forecast.hourly.slice(0, 12).map((p) => (
                    <div key={p.number} className="min-w-[68px] bg-container border border-subtle p-2 text-center">
                      <div className="text-[10px] font-mono text-neutral-400">
                        {new Date(p.startTime).toLocaleTimeString([], { hour: 'numeric' })}
                      </div>
                      <div className="font-mono text-lg mt-1">{fmtTemp(p.temperature, p.temperatureUnit)}</div>
                      <div className="text-[10px] text-neutral-500 mt-1 truncate">{p.shortForecast}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Alerts (NOAA + Canada) */}
            {(() => {
              const all = [
                ...(bundle?.alerts?.alerts || []).map((a) => ({ ...a, source: 'NOAA' })),
                ...(bundle?.canada_alerts?.alerts || []).map((a) => ({ ...a, source: 'Canada' })),
              ];
              if (!all.length) return null;
              return (
                <div className="mb-6">
                  <h2 className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-sev-severe" /> Active alerts
                  </h2>
                  <div className="bg-container border border-subtle">
                    {all.slice(0, 5).map((a, i) => {
                      const c = severityClass(a.severity);
                      return (
                        <div key={a.id || i} className="p-3 border-b border-subtle last:border-0" data-testid="home-alert-row">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] uppercase tracking-widest px-2 py-0.5 border ${c.bg} ${c.text} ${c.border} font-mono`}>
                              {a.severity || 'Info'} · {a.source}
                            </span>
                          </div>
                          <div className="text-sm font-medium leading-tight">{a.event || a.headline || 'Alert'}</div>
                          <div className="text-xs text-neutral-400 mt-1 line-clamp-2">{a.headline || a.areaDesc}</div>
                          <div className="text-[10px] font-mono text-neutral-500 mt-1">{formatTime(a.effective || a.sent)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Recent earthquakes nearby */}
            {Array.isArray(bundle?.usgs?.events) && bundle.usgs.events.length > 0 && (
              <div className="mb-6">
                <h2 className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 mb-2">Recent earthquakes (300mi)</h2>
                <div className="bg-container border border-subtle">
                  {bundle.usgs.events.slice(0, 4).map((e) => (
                    <div key={e.id} className="flex items-center gap-3 p-3 border-b border-subtle last:border-0">
                      <div className={clsx(
                        'w-10 h-10 flex items-center justify-center font-mono text-sm font-bold',
                        e.magnitude >= 7 ? 'bg-mag-critical text-white' :
                        e.magnitude >= 5 ? 'bg-mag-high text-black' :
                        e.magnitude >= 3 ? 'bg-mag-mid text-black' : 'bg-mag-low text-black'
                      )}>
                        {Number(e.magnitude).toFixed(1)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{e.place}</div>
                        <div className="text-[10px] font-mono text-neutral-500">
                          {e.depth_km != null && `${e.depth_km.toFixed(0)} km · `}
                          {e.distance_miles != null && `${e.distance_miles.toFixed(0)} mi away`}
                        </div>
                      </div>
                      <ArrowUpRight strokeWidth={1.5} className="w-4 h-4 text-neutral-500" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {err && (
              <div className="text-xs bg-sev-severe/10 border border-sev-severe/40 text-sev-severe p-2 mb-4" data-testid="home-error">{err}</div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

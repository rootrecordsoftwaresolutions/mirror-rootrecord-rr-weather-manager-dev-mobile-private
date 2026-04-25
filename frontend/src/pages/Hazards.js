import React, { useEffect, useMemo, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { Activity, Waves, Wind, Flame, RefreshCw, Loader2, ArrowUpRight } from 'lucide-react';
import { api } from '../lib/api';
import { fmtMileOrKm, formatTime, timeAgo, clsx } from '../lib/format';

const TAB_KEYS = [
  { id: 'earthquakes', label: 'Earthquakes', icon: Activity, testId: 'hazard-tab-earthquakes' },
  { id: 'tsunamis', label: 'Tsunamis', icon: Waves, testId: 'hazard-tab-tsunamis' },
  { id: 'cyclones', label: 'Cyclones', icon: Wind, testId: 'hazard-tab-cyclones' },
  { id: 'wildfires', label: 'Wildfires', icon: Flame, testId: 'hazard-tab-wildfires' },
];

function magClass(m) {
  m = Number(m) || 0;
  if (m >= 7) return 'bg-mag-critical text-white';
  if (m >= 5) return 'bg-mag-high text-black';
  if (m >= 3) return 'bg-mag-mid text-black';
  return 'bg-mag-low text-black';
}

export default function Hazards() {
  const [tab, setTab] = useState('earthquakes');
  const [activeLoc, setActiveLoc] = useState(null);
  const [eqs, setEqs] = useState([]); const [eqsLoad, setEqsLoad] = useState(false);
  const [tsus, setTsus] = useState([]); const [tsusLoad, setTsusLoad] = useState(false);
  const [cyc, setCyc] = useState([]); const [cycLoad, setCycLoad] = useState(false);
  const [fires, setFires] = useState([]); const [firesLoad, setFiresLoad] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.listLocations();
        const id = localStorage.getItem('rrwm.activeLocationId');
        const loc = (data || []).find((l) => l.id === id) || (data || [])[0] || null;
        setActiveLoc(loc);
      } catch (e) { setErr(String(e?.message || e)); }
    })();
  }, []);

  const loadEarthquakes = async () => {
    setEqsLoad(true);
    try {
      if (activeLoc) {
        const { data } = await api.earthquakes(activeLoc.latitude, activeLoc.longitude, { period: 'week', min: 2.5, radius: 2000 });
        setEqs(data?.events || []);
      } else {
        const { data } = await api.earthquakes(0, 0, { period: 'day', min: 4.0, radius: 99999 });
        setEqs(data?.events || []);
      }
    } catch (e) { setErr(String(e?.response?.data?.detail || e?.message || e)); }
    finally { setEqsLoad(false); }
  };
  const loadTsunamis = async () => {
    setTsusLoad(true);
    try { const { data } = await api.tsunamis(); setTsus(data?.bulletins || []); }
    catch (e) { setErr(String(e?.message || e)); } finally { setTsusLoad(false); }
  };
  const loadCyclones = async () => {
    setCycLoad(true);
    try { const { data } = await api.cyclones(); setCyc(data?.events || []); }
    catch (e) { setErr(String(e?.message || e)); } finally { setCycLoad(false); }
  };
  const loadWildfires = async () => {
    setFiresLoad(true);
    try { const { data } = await api.wildfires(); setFires(data?.events || []); }
    catch (e) { setErr(String(e?.message || e)); } finally { setFiresLoad(false); }
  };

  useEffect(() => { if (tab === 'earthquakes') loadEarthquakes(); }, [tab, activeLoc]); // eslint-disable-line
  useEffect(() => { if (tab === 'tsunamis' && tsus.length === 0) loadTsunamis(); }, [tab]); // eslint-disable-line
  useEffect(() => { if (tab === 'cyclones' && cyc.length === 0) loadCyclones(); }, [tab]); // eslint-disable-line
  useEffect(() => { if (tab === 'wildfires' && fires.length === 0) loadWildfires(); }, [tab]); // eslint-disable-line

  const onRefresh = () => {
    if (tab === 'earthquakes') loadEarthquakes();
    if (tab === 'tsunamis') loadTsunamis();
    if (tab === 'cyclones') loadCyclones();
    if (tab === 'wildfires') loadWildfires();
  };

  const loading = useMemo(() => ({
    earthquakes: eqsLoad, tsunamis: tsusLoad, cyclones: cycLoad, wildfires: firesLoad
  }[tab]), [tab, eqsLoad, tsusLoad, cycLoad, firesLoad]);

  return (
    <div className="animate-fadein" data-testid="hazards-page">
      <header className="flex items-center justify-between p-4 pb-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hazards</h1>
          <p className="text-xs text-neutral-500 font-mono uppercase tracking-widest">USGS · NASA EONET</p>
        </div>
        <button
          aria-label="Refresh hazards"
          data-testid="hazards-refresh-button"
          onClick={onRefresh}
          className={clsx('p-2 rounded-sm border border-subtle hover:bg-containerHover active:scale-95', loading && 'animate-spinSlow')}
        >
          <RefreshCw strokeWidth={1.5} className="w-4 h-4" />
        </button>
      </header>

      <Tabs.Root value={tab} onValueChange={setTab} className="px-4">
        <Tabs.List className="flex gap-1 border-b border-subtle mb-3 overflow-x-auto no-scrollbar" data-testid="hazards-tabs">
          {TAB_KEYS.map((t) => (
            <Tabs.Trigger
              key={t.id}
              value={t.id}
              data-testid={t.testId}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-2 text-xs uppercase tracking-widest font-mono border-b-2 -mb-px transition-colors active:scale-95',
                'data-[state=active]:text-accent data-[state=active]:border-accent text-neutral-500 border-transparent'
              )}
            >
              <t.icon strokeWidth={1.5} className="w-4 h-4" />
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {err && (
          <div className="text-xs bg-sev-severe/10 border border-sev-severe/40 text-sev-severe p-2 mb-3" data-testid="hazards-error">
            {err}
          </div>
        )}

        <Tabs.Content value="earthquakes">
          {loading && eqs.length === 0 ? <ListSkeleton /> : (
            <div className="bg-container border border-subtle" data-testid="earthquakes-list">
              {eqs.length === 0 && <Empty label="No earthquakes in the configured radius." />}
              {eqs.map((e) => (
                <a
                  key={e.id}
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="earthquake-row"
                  className="flex items-center gap-3 p-3 border-b border-subtle last:border-0 hover:bg-containerHover active:scale-[.99]"
                >
                  <div className={clsx('w-11 h-11 flex items-center justify-center font-mono text-sm font-bold', magClass(e.magnitude))}>
                    {Number(e.magnitude).toFixed(1)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{e.place || 'Unknown region'}</div>
                    <div className="text-[10px] font-mono text-neutral-500">
                      {e.depth_km != null && `${e.depth_km.toFixed(0)} km · `}
                      {e.distance_miles != null && `${fmtMileOrKm(e.distance_miles)} away · `}
                      {timeAgo(e.time)}
                    </div>
                  </div>
                  <ArrowUpRight strokeWidth={1.5} className="w-4 h-4 text-neutral-500" />
                </a>
              ))}
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="tsunamis">
          {loading && tsus.length === 0 ? <ListSkeleton /> : (
            <div className="bg-container border border-subtle" data-testid="tsunamis-list">
              {tsus.length === 0 && <Empty label="No active tsunami-flagged events." />}
              {tsus.map((b) => (
                <a key={b.id} href={b.url} target="_blank" rel="noreferrer" className="block p-3 border-b border-subtle last:border-0 hover:bg-containerHover">
                  <div className="text-[10px] uppercase tracking-widest text-sev-severe font-mono">Tsunami flag · M{Number(b.magnitude).toFixed(1)}</div>
                  <div className="text-sm">{b.title}</div>
                  <div className="text-[10px] font-mono text-neutral-500 mt-1">{timeAgo(b.time)}</div>
                </a>
              ))}
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="cyclones">
          {loading && cyc.length === 0 ? <ListSkeleton /> : (
            <div className="bg-container border border-subtle" data-testid="cyclones-list">
              {cyc.length === 0 && <Empty label="No active cyclone events." />}
              {cyc.map((e) => (
                <a
                  key={e.id}
                  href={`https://www.google.com/search?q=${encodeURIComponent(e.title + ' cyclone')}`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="cyclone-row"
                  className="block p-3 border-b border-subtle last:border-0 hover:bg-containerHover"
                >
                  <div className="text-[10px] uppercase tracking-widest text-sev-moderate font-mono">{(e.categories||[]).join(' · ') || 'Severe storm'}</div>
                  <div className="text-sm">{e.title}</div>
                  <div className="text-[10px] font-mono text-neutral-500 mt-1">{formatTime(e.date)}{e.lat!=null && ` · ${e.lat.toFixed(1)},${e.lon.toFixed(1)}`}</div>
                </a>
              ))}
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="wildfires">
          {loading && fires.length === 0 ? <ListSkeleton /> : (
            <div className="bg-container border border-subtle" data-testid="wildfires-list">
              {fires.length === 0 && <Empty label="No active wildfire events." />}
              {fires.map((e) => (
                <a key={e.id} href={(e.sources||[])[0]} target="_blank" rel="noreferrer" className="block p-3 border-b border-subtle last:border-0 hover:bg-containerHover">
                  <div className="text-[10px] uppercase tracking-widest text-sev-severe font-mono flex items-center gap-1"><Flame className="w-3 h-3"/> Wildfire</div>
                  <div className="text-sm">{e.title}</div>
                  <div className="text-[10px] font-mono text-neutral-500 mt-1">{formatTime(e.date)}{e.lat!=null && ` · ${e.lat.toFixed(1)},${e.lon.toFixed(1)}`}</div>
                </a>
              ))}
            </div>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2" data-testid="hazards-list-skeleton">
      {[0,1,2,3,4].map((i) => <div key={i} className="h-14 skeleton" />)}
    </div>
  );
}

function Empty({ label }) {
  return (
    <div className="p-6 text-center text-sm text-neutral-500" data-testid="hazards-empty">
      <Loader2 className="w-4 h-4 animate-spin inline-block mr-2 opacity-0" /> {label}
    </div>
  );
}

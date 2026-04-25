import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, MapPin, Plus, Trash2, User, Settings as SettingsIcon, Lock, Mail, Globe, ChevronRight } from 'lucide-react';
import { api, session } from '../lib/api';
import { getUnits, setUnits } from '../lib/format';

function Section({ title, children, testId }) {
  return (
    <section className="mb-6" data-testid={testId}>
      <h2 className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 mb-2 px-4">{title}</h2>
      <div className="bg-container border border-subtle">{children}</div>
    </section>
  );
}

function Row({ icon: Icon, label, value, onClick, testId, danger }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`flex items-center gap-3 w-full p-4 border-b border-subtle last:border-0 hover:bg-containerHover active:scale-[.99] text-left ${danger ? 'text-sev-severe' : 'text-white'}`}
    >
      {Icon && <Icon strokeWidth={1.5} className="w-4 h-4 shrink-0 opacity-80" />}
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        {value && <div className="text-[10px] font-mono text-neutral-500 mt-0.5 truncate">{value}</div>}
      </div>
      {!danger && onClick && <ChevronRight strokeWidth={1.5} className="w-4 h-4 text-neutral-500" />}
    </button>
  );
}

export default function Settings({ onSignedOut }) {
  const navigate = useNavigate();
  const [locations, setLocations] = useState([]);
  const [units, setUnitsState] = useState(getUnits());

  const load = async () => {
    try {
      const { data } = await api.listLocations();
      setLocations(data || []);
    } catch (_e) { /* ignore */ }
  };
  useEffect(() => { load(); }, []);

  const onSignOut = () => {
    session.clearSession();
    localStorage.removeItem('rrwm.guestAccepted');
    onSignedOut?.();
    navigate('/');
  };

  const removeLoc = async (id) => {
    if (!window.confirm('Delete this saved location?')) return;
    try { await api.deleteLocation(id); load(); } catch (e) { alert(e?.response?.data?.detail || e.message); }
  };

  const toggleUnits = () => {
    const next = units === 'imperial' ? 'metric' : 'imperial';
    setUnits(next);
    setUnitsState(next);
  };

  const isAuthed = session.isAuthed();
  const email = session.getEmail();
  const isPro = session.isPro();

  return (
    <div className="animate-fadein pb-8" data-testid="settings-page">
      <header className="flex items-center justify-between p-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Account · Locations · Preferences</p>
        </div>
        <SettingsIcon strokeWidth={1.5} className="w-5 h-5 text-neutral-500" />
      </header>

      <Section title="Account" testId="settings-account-section">
        {isAuthed ? (
          <>
            <Row icon={Mail} label="Signed in as" value={email || '—'} testId="settings-account-email" />
            <Row icon={isPro ? Globe : Lock} label={isPro ? 'Root Record Pro' : 'Free tier'} value={isPro ? 'Critical popups + custom sounds enabled' : 'Critical popups locked — visit RootRecord.com'} testId="settings-tier" />
            <Row icon={LogOut} label="Sign out of this device" onClick={onSignOut} testId="settings-signout" danger />
          </>
        ) : (
          <>
            <Row icon={User} label="Guest mode" value="Throttled refresh, no cloud sync" testId="settings-guest" />
            <Row icon={LogOut} label="Sign in" onClick={() => { localStorage.removeItem('rrwm.guestAccepted'); window.location.reload(); }} testId="settings-signin" />
          </>
        )}
      </Section>

      <Section title="Saved locations" testId="settings-locations-section">
        {locations.map((l) => (
          <div key={l.id} className="flex items-center gap-3 p-4 border-b border-subtle last:border-0">
            <MapPin strokeWidth={1.5} className="w-4 h-4 text-accent" />
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{l.name}</div>
              <div className="text-[10px] font-mono text-neutral-500">{l.latitude.toFixed(4)}, {l.longitude.toFixed(4)}</div>
            </div>
            <button
              onClick={() => removeLoc(l.id)}
              data-testid={`settings-location-delete-${l.id}`}
              className="p-2 text-neutral-500 hover:text-sev-severe active:scale-90"
              aria-label="Delete location"
            >
              <Trash2 strokeWidth={1.5} className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() => navigate('/locations/new')}
          data-testid="settings-add-location"
          className="flex items-center gap-3 w-full p-4 border-t border-subtle hover:bg-containerHover active:scale-[.99] text-accent"
        >
          <Plus strokeWidth={1.5} className="w-4 h-4" /> Add location
        </button>
      </Section>

      <Section title="Preferences" testId="settings-prefs-section">
        <Row
          label="Units"
          value={units === 'imperial' ? 'Imperial — °F · mph · mi' : 'Metric — °C · km/h · km'}
          onClick={toggleUnits}
          testId="settings-units-toggle"
        />
      </Section>

      <Section title="Pro alerts" testId="settings-pro-section">
        <div className="p-4 text-xs text-neutral-400 leading-relaxed">
          {isPro
            ? 'Critical popups and custom sounds are enabled. Configure them on the desktop app — mobile sync is coming next.'
            : 'Critical popups + custom alert sounds are part of Root Record Pro. Subscribe at RootRecord.com to unlock.'}
        </div>
      </Section>

      <p className="text-center text-[10px] font-mono text-neutral-600 mt-8">Root Record Weather Manager Mobile · v1.0.0</p>
    </div>
  );
}

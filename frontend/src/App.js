import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import AuthGate from './pages/AuthGate';
import Home from './pages/Home';
import Hazards from './pages/Hazards';
import Settings from './pages/Settings';
import LocationMap from './pages/LocationMap';
import TabBar from './components/TabBar';
import GuestBanner from './components/GuestBanner';
import { session } from './lib/api';

function useGate() {
  const [decided, setDecided] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [guest, setGuest] = useState(false);

  useEffect(() => {
    const acceptedGuest = localStorage.getItem('rrwm.guestAccepted') === '1';
    setAuthed(session.isAuthed());
    setGuest(acceptedGuest);
    setDecided(true);
  }, []);

  return { decided, authed, guest, setAuthed, setGuest };
}

export default function App() {
  const { decided, authed, guest, setAuthed, setGuest } = useGate();
  const location = useLocation();
  const hideTabs = location.pathname.startsWith('/auth') || location.pathname.startsWith('/locations/new');

  if (!decided) return <div className="h-screen w-screen bg-app" />;
  if (!authed && !guest) {
    return (
      <Routes>
        <Route
          path="*"
          element={
            <AuthGate
              onSignedIn={() => setAuthed(true)}
              onContinueGuest={() => {
                localStorage.setItem('rrwm.guestAccepted', '1');
                setGuest(true);
              }}
            />
          }
        />
      </Routes>
    );
  }

  return (
    <div className="min-h-screen bg-app text-white pb-20">
      <GuestBanner />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/hazards" element={<Hazards />} />
        <Route path="/settings" element={<Settings onSignedOut={() => { setAuthed(false); setGuest(false); }} />} />
        <Route path="/locations/new" element={<LocationMap />} />
        <Route path="/auth" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!hideTabs && <TabBar />}
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Search, X } from 'lucide-react';
import L from 'leaflet';
import { api } from '../lib/api';

// Fix leaflet default marker icons in webpack/CRA bundle.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export default function LocationMap() {
  const navigate = useNavigate();
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [coords, setCoords] = useState(null);
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const map = L.map('rrwm-map', {
      zoomControl: false,
      attributionControl: true,
    }).setView([39.8283, -98.5795], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    map.on('click', (e) => {
      const { lat, lng } = e.latlng;
      setCoords({ lat, lng });
      if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
      else markerRef.current = L.marker([lat, lng]).addTo(map);
    });

    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 100);

    // Try to use device geolocation as initial guess
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          map.setView([pos.coords.latitude, pos.coords.longitude], 10);
        },
        () => {},
        { enableHighAccuracy: false, timeout: 5000 }
      );
    }

    return () => map.remove();
  }, []);

  const doSearch = async (e) => {
    e.preventDefault();
    if (!search.trim()) return;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(search)}&format=json&limit=1`, {
        headers: { 'Accept-Language': 'en' },
      });
      const j = await r.json();
      if (Array.isArray(j) && j.length) {
        const lat = parseFloat(j[0].lat);
        const lng = parseFloat(j[0].lon);
        setCoords({ lat, lng });
        if (mapRef.current) {
          mapRef.current.setView([lat, lng], 11);
          if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
          else markerRef.current = L.marker([lat, lng]).addTo(mapRef.current);
        }
        if (!name) setName(j[0].display_name.split(',')[0]);
      } else {
        setErr('No matching place found.');
      }
    } catch (e2) {
      setErr(String(e2?.message || e2));
    }
  };

  const save = async () => {
    setErr('');
    if (!coords) return setErr('Tap on the map to select a point.');
    if (!name.trim()) return setErr('Enter a name for this location.');
    setBusy(true);
    try {
      const { data } = await api.createLocation({ name: name.trim(), latitude: coords.lat, longitude: coords.lng });
      localStorage.setItem('rrwm.activeLocationId', data.id);
      navigate('/');
    } catch (e) {
      setErr(String(e?.response?.data?.detail || e?.message || 'Failed to save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-app flex flex-col" data-testid="location-map-page">
      {/* Top bar */}
      <div className="flex items-center gap-2 p-3 bg-app/90 backdrop-blur-xl border-b border-subtle z-10">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-containerHover" data-testid="location-back">
          <ArrowLeft strokeWidth={1.5} className="w-4 h-4" />
        </button>
        <form onSubmit={doSearch} className="flex-1 flex items-center gap-2 bg-container border border-subtle px-3">
          <Search strokeWidth={1.5} className="w-4 h-4 text-neutral-500" />
          <input
            data-testid="location-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search a place"
            className="bg-transparent outline-none text-sm flex-1 py-2"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="text-neutral-500"><X className="w-4 h-4" /></button>
          )}
        </form>
      </div>

      <div id="rrwm-map" className="flex-1" />

      {/* Bottom sheet */}
      <div className="bg-container border-t border-subtle p-4 animate-slideup">
        <div className="text-[10px] font-mono uppercase tracking-widest text-neutral-500 mb-1">Selected coordinates</div>
        <div className="font-mono text-sm mb-3" data-testid="location-coords">
          {coords ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : '— Tap map to choose —'}
        </div>
        <input
          data-testid="location-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Location name (Home, Cabin…)"
          className="w-full bg-app border border-subtle px-3 py-3 text-sm outline-none focus:border-accent"
        />
        {err && (
          <div className="text-xs bg-sev-severe/10 border border-sev-severe/40 text-sev-severe p-2 mt-3" data-testid="location-error">
            {err}
          </div>
        )}
        <button
          onClick={save}
          disabled={busy || !coords}
          data-testid="location-save-button"
          className="mt-3 w-full bg-accent hover:bg-accentHover text-white py-3 rounded-sm flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
        >
          <Check strokeWidth={1.5} className="w-4 h-4" /> {busy ? 'Saving…' : 'Save location'}
        </button>
      </div>
    </div>
  );
}

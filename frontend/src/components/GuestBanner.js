import React from 'react';
import { session } from '../lib/api';
import { ShieldAlert } from 'lucide-react';

export default function GuestBanner() {
  if (session.isAuthed()) return null;
  return (
    <div
      className="sticky top-0 z-30 bg-[#7F1D1D] text-[#FECACA] text-[11px] py-1.5 px-4 text-center flex items-center justify-center gap-1.5"
      role="alert"
      data-testid="guest-mode-banner"
    >
      <ShieldAlert strokeWidth={1.5} className="w-3.5 h-3.5" />
      <span>
        <strong className="font-semibold">Guest mode.</strong>{' '}
        Cloud sync is off and live data refresh is throttled. Sign in for full access.
      </span>
    </div>
  );
}

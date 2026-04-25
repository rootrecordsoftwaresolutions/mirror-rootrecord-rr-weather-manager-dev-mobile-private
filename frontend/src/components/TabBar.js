import React from 'react';
import { NavLink } from 'react-router-dom';
import { Home, Activity, Settings as SettingsIcon } from 'lucide-react';
import { clsx } from '../lib/format';

const tabs = [
  { to: '/', label: 'Home', icon: Home, testId: 'tab-home' },
  { to: '/hazards', label: 'Hazards', icon: Activity, testId: 'tab-hazards' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, testId: 'tab-settings' },
];

export default function TabBar() {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 h-16 bg-app/90 backdrop-blur-xl border-t border-subtle"
      data-testid="bottom-tab-bar"
    >
      <ul className="grid grid-cols-3 h-full">
        {tabs.map((t) => (
          <li key={t.to} className="flex">
            <NavLink
              to={t.to}
              end={t.to === '/'}
              data-testid={t.testId}
              className={({ isActive }) =>
                clsx(
                  'flex flex-col items-center justify-center w-full gap-1 transition-colors active:scale-95',
                  isActive ? 'text-accent' : 'text-neutral-400 hover:text-white'
                )
              }
            >
              <t.icon strokeWidth={1.5} className="w-6 h-6" />
              <span className="text-[10px] uppercase tracking-widest font-mono">{t.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

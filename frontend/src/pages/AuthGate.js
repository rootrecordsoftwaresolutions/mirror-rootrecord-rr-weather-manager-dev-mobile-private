import React, { useState } from 'react';
import { Cloud, ArrowRight, Loader2 } from 'lucide-react';
import { api, session } from '../lib/api';

export default function AuthGate({ onSignedIn, onContinueGuest }) {
  const [mode, setMode] = useState('signin'); // signin | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!email.trim() || password.length < 6) {
      setErr('Enter an email and a password (6+ characters).');
      return;
    }
    setBusy(true);
    try {
      const fn = mode === 'signin' ? api.login : api.signup;
      const { data } = await fn(email.trim(), password);
      if (!data.token) throw new Error('No session token returned. Try again.');
      session.setSession(data.token, data.email, data.pro_unlocked);
      onSignedIn?.();
    } catch (e2) {
      const msg = e2?.response?.data?.detail || e2?.message || 'Sign in failed.';
      setErr(String(msg));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-app flex flex-col">
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm animate-slideup">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 rounded-md bg-accent/10 border border-accent/30 flex items-center justify-center">
              <Cloud strokeWidth={1.5} className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight" data-testid="auth-app-title">Root Record</h1>
              <p className="text-xs text-neutral-400 uppercase tracking-[.2em] font-mono">Weather Manager</p>
            </div>
          </div>

          <div className="flex gap-2 mb-6 text-xs uppercase tracking-widest font-mono">
            <button
              data-testid="auth-tab-signin"
              onClick={() => setMode('signin')}
              className={`pb-2 border-b-2 ${mode === 'signin' ? 'text-white border-accent' : 'text-neutral-500 border-transparent'}`}
            >
              Sign in
            </button>
            <button
              data-testid="auth-tab-signup"
              onClick={() => setMode('signup')}
              className={`pb-2 border-b-2 ${mode === 'signup' ? 'text-white border-accent' : 'text-neutral-500 border-transparent'}`}
            >
              Create account
            </button>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-neutral-400 font-mono">Email</span>
              <input
                data-testid="auth-email-input"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full bg-container border border-subtle rounded-sm px-3 py-3 outline-none focus:border-accent transition-colors"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-neutral-400 font-mono">Password</span>
              <input
                data-testid="auth-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                className="mt-1 w-full bg-container border border-subtle rounded-sm px-3 py-3 outline-none focus:border-accent transition-colors"
              />
            </label>

            {err && (
              <div className="text-xs bg-sev-severe/10 border border-sev-severe/40 text-sev-severe p-2 rounded-sm" data-testid="auth-error">
                {err}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              data-testid="auth-submit-button"
              className="bg-accent hover:bg-accentHover text-white py-3 rounded-sm flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <div className="my-6 flex items-center gap-3 text-xs text-neutral-500">
            <div className="flex-1 border-t border-subtle" />
            <span className="font-mono uppercase tracking-widest">or</span>
            <div className="flex-1 border-t border-subtle" />
          </div>

          <button
            data-testid="continue-guest-button"
            onClick={onContinueGuest}
            className="w-full border border-subtle text-neutral-300 hover:bg-containerHover py-3 rounded-sm active:scale-95 transition-all"
          >
            Continue without signing in
          </button>

          <p className="mt-6 text-[11px] text-neutral-500 leading-relaxed">
            Guest mode keeps your data on this device. Cloud sync, Pro alert sounds, and unlimited
            refreshes require a Root Record account.
          </p>
        </div>
      </div>
    </div>
  );
}

# Local development

## Prereqs

- **Node.js** (LTS) and **npm** on **Windows x64** for desktop parity.
- Native module **sqlite3** — after `npm ci`, postinstall should build; if it fails, fix toolchain (VS Build Tools, Python) as usual for `node-gyp` on Windows.

## Clone and install

```text
npm ci
npm start
```

`prestart` / `predev` run `prepare:icon` and `sync-notification-sounds`, which populate `assets/favicon.ico` (if needed) and `assets/notification-sounds` from `assets/notification-sounds-source`.

- **`npm run dev`** — `electron . --dev` (same preflight as `npm start`).

## Environment variables (most common)

| Variable | Purpose |
|----------|--------|
| `RR_WEATHER_HOME` | Absolute path to the Weather Manager data folder (overrides default profile-based path). |
| `ROOTRECORD_HOME` | If set, user data is under `ROOTRECORD_HOME/Weather Manager`. |
| `LICENSE_API_BASE_URL` | Override for the **license** API (HTTPS; `http` allowed only for `localhost` in dev). See `licenseService.js` shipped default. |
| `LICENSE_API_SECRET` | **Shared bearer** for core/auth routes when the Worker expects it — treat as a **secret**; not for public issue trackers. |
| `LICENSE_FORCE_SIGNIN_ONLY` | `1` / `true` — sign-in only mode (omit client secret). |
| `LICENSE_PAYMENT_LINK_URL` | Stripe (or other) **payment** link base for Pro checkout. |
| `ROOTRECORD_BACKUP_API_BASE_URL` | Optional override for **cloud backup** endpoint (see `cloudBackup.js`). |
| `RR_ALERT_SOUNDS_DIR` | Extra directory to scan for **critical alert** sound clips. |
| `RR_DISABLE_AUTO_UPDATE` | `1` — never check GitHub for updates. |
| `RR_USE_IMAGEMAGICK_ICO` / brand overrides | See `scripts/prepare-weather-assets.cjs` and `assets/README.md` for `RR_WEATHER_BRAND_SOURCE`, `RR_NSIS_SIDEBAR_SOURCE`, `RR_NOTIFICATION_SOUNDS_SOURCE`. |

`main.js` also sets **IPv4-first DNS** when available to avoid **ConnectTimeout** on `fetch` for some users.

## Where data lives (Windows)

- Default: `%USERPROFILE%\RootRecord\Weather Manager` (with a one-time migration from `%LOCALAPPDATA%\RootRecord\Weather Manager` if the new folder has no DB yet).
- Portable install: `weather-manager-data-path.txt` next to the `.exe` can point to a custom data directory.

`electron-store` and SQLite live under the resolved data directory.

## Dev vs packaged

- **Unpacked** (`npm start`) — not all updater paths run; `autoUpdate.js` skips or reduces behavior for dev. See that file and root **README** FAQ.
- **Packaged** — uses `process.resourcesPath` for `notification-sounds` and `app-update.yml` as in `package.json` `build.extraResources`.

## Troubleshooting

- **Blank / no live data** — the app may require at least one **saved location** (see product README). Check console for fetch errors.
- **Network / timeout** — confirm IPv4 connectivity; the app forces IPv4-first `dns` order.
- **Missing sounds** — run `npm run prepare:assets` or `npm start` so `assets/notification-sounds` is populated.

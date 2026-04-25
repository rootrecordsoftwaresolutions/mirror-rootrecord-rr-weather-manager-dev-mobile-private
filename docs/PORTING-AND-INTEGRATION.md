# Porting and integration (e.g. Android, iOS)

This repository is a **Windows Electron** app. A native **mobile** client is **not** a port of the Electron process model; plan to **re-implement the UI and lifecycle** and align with the same product rules and backends where they apply.

## What to reuse as **spec**

- **Product behavior** — user-facing flows described in the root `README` (guest vs signed in, at least one location, update checks from public Releases, etc.).
- **License and account** — the **HTTP API** shape in `src/licenseService.js` (e.g. `/v1` routes, entitlement caching, device id files are desktop-specific). A mobile app should use **your** secure session model, not a copy of on-disk `license_*.json` files.
- **Data contracts** — understand what the current app **stores in SQLite** and what it **fetches** from public APIs; mobile may choose different caching and sync, but the **source-of-truth** and privacy story should match product policy.
- **Optional backup / cloud** — `src/cloudBackup.js` shows how the desktop app negotiates with an optional **backup** service URL (`ROOTRECORD_BACKUP_API_BASE_URL` override). Any mobile “sync” must be designed and documented for that platform.

## What not to expect

- No shared **UI** or **view** code with Electron; **preload** and **IPC** are not applicable. Replace with the platform’s navigation, permissions, and background work rules.
- **NSIS** / `electron-builder` / `win-unpacked` are irrelevant to mobile. Ignore `release/`, `dist/`, and Windows-only scripts for store builds.
- **electron-updater** does not apply. Mobile apps use **App Store** / **Play** updates (or in-app **OTA** you define separately), not `latest.yml` from GitHub.

## Design and media

- **Colors, iconography, marketing stills** — `assets/README.md` distinguishes **runtime** art (`favicon.ico`, `installer-sidebar.jpg`, `notification-sounds-source/`) from **reference-only** **marketing** files (posters, photos) for a consistent brand on new platforms.
- `COMMERCIAL_API_PRICE_CHART.txt` and `FREEMIUM_PRO_OPTIONS.txt` in the repo root (if present) are **context** for tiers and commercial positioning, not runtime.

## Suggested work order for a new client

1. Re-read the root `README` and [ARCHITECTURE.md](./ARCHITECTURE.md) for feature scope and auth modes.
2. List **endpoints and headers** the desktop app actually calls (search `fetch` in `src/` and `licenseService.js`, plus `cloudBackup.js`).
3. Prototype **auth and entitlement** against staging if you have `LICENSE_API_BASE_URL` set for dev.
4. Recreate **location, alerts, and hazard** UX to match policy and your platform’s **network** and **location** permissions.

If you add a new platform-specific repo, link to this private source and keep **one** public customer-facing version story in the org’s download/README sites.

# Architecture (Electron)

## Runtime shape

- **Main process** — `src/main.js` (very large: window lifecycle, **SQLite** database, all **IPC** handlers, scheduling, guest vs signed-in behavior).
- **No separate React/Vue** — the UI is **in-process HTML** loaded from the app data / packaged resources; the main process wires `BrowserWindow` and `ipcMain.handle`.
- **Preload** — `src/preload.js` exposes a small **`window.rrWeatherIpc` / `rootRecordBridge`** surface (`invoke`, license helpers). Most IPC channels are still used through `invoke` with string channel names (see `main.js`).
- **Context isolation** — preloads are written for `contextIsolated: true` when that path is used.

## Core modules (under `src/`)

| Module | Role |
|--------|------|
| `main.js` | App entry, paths, **electron-store** config, **sqlite3** DB, IPC API for weather/archive/auth/backup/sounds, guest refresh limits, **IPv4-first DNS** (`dns.setDefaultResultOrder('ipv4first')`) to avoid undici timeouts on some Windows/IPv6 setups. |
| `licenseService.js` | Root Record **account API** (login, entitlement, device id, session files). Shipped default base URL is documented in that file; override with `LICENSE_API_BASE_URL` (see [DEVELOPMENT.md](./DEVELOPMENT.md)). |
| `cloudBackup.js` | Local and optional **online** backup; uses `ROOTRECORD_BACKUP_API_BASE_URL` or shipped default. |
| `weatherSyncEngine.js` | Ingestion / sync logic for weather and hazard data into the local DB. |
| `autoUpdate.js` | **electron-updater**; reads packaged `app-update.yml`, respects `RR_DISABLE_AUTO_UPDATE`, `argv --no-update-check`, Store-style paths. |

`package.json` `build` block is **electron-builder** (NSIS, `extraResources`, asar rules).

## IPC (representative; full list in `main.js`)

Handlers include (non-exhaustive): `get-location-config` / `save-location-config`, `fetch-noaa-alerts`, `fetch-canada-alerts`, `fetch-usgs-events`, `fetch-noaa-forecast`, `fetch-noaa-dashboard`, `fetch-tsunami-bulletins`, `fetch-cyclones`, `fetch-wildfires`, `archive-*`, `store-records`, `core-auth-*`, `license-*`, `backup-*`, `get-alert-sounds`, `weather-check-for-updates`, `open-external-url`, etc.

## Data and identity

- **User data** — resolved under a **Weather Manager** folder (see [DEVELOPMENT.md](./DEVELOPMENT.md) for `RR_WEATHER_HOME` / `ROOTRECORD_HOME` and legacy migration from `%LOCALAPPDATA%\RootRecord\Weather Manager`).
- **App User Model ID (Windows taskbar)** — `com.rootrecord.weather-manager`, must match `package.json` `appId` / `build.appId` / NSIS expectations.
- **SQLite** — `weather-manager.db` and related state live alongside store JSON under the resolved home.

## Public vs auth’d behavior

- **Guest** — live public data refresh is **capped**; a red banner and IPC paths reflect guest mode.
- **Signed in** — entitlements and Pro features are enforced via `licenseService` + cached entitlement files.

## Updates

- Packaged `resources/app-update.yml` (from `build/app-update.yml`) points **electron-updater** at the **public** `RootRecord/rootrecord-weather-manager-download` GitHub **Releases** org repo, not the private source repo. See [BUILD-AND-RELEASE.md](./BUILD-AND-RELEASE.md).

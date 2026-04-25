# Changelog

Release notes for **Root Record Weather Manager**. **Download the Windows installer** from **[Releases](https://github.com/RootRecord/rootrecord-weather-manager-download/releases)**.

---

## [1.0.17] - 2026-04-25

### Changed

- Bumped the published **app and installer** version to **1.0.17** (next **GitHub Release** / **electron-updater** line). No app behavior change from 1.0.16 in this version bump.

### For maintainers

- **`docs/RELEASE.md`** — v1.0.17 runbook, **`gh release create`** example, **`latest.yml`** verification. **`npm run latest-yml`** writes **`release/latest.yml`** for the final Setup **.exe** (use after signing).
- **`docs/github/RELEASE_v1.0.17.md`** — copy-paste (or `gh` **`--notes-file`**) for the [download repository](https://github.com/RootRecord/rootrecord-weather-manager-download) release page. Index: **`docs/github/README.md`**.
- **`.gitignore`** — `release/`, `dist/`, and common electron-builder detritus stay out of Git; the **Releases** page is for the **.exe** + **`latest.yml`**, not a push of the whole build folder.

---

## [1.0.16] - 2026-04-24

### Added

- **Updates (GitHub)** — Packaged installs **re-check** [Releases](https://github.com/RootRecord/rootrecord-weather-manager-download/releases) on a **timer** (every few hours) as well as shortly after launch. **About → Check for updates…** runs the same **electron-updater** flow and shows **“You’re on the latest…”** when nothing newer is published.
- **Guest mode banner** — If you use **Continue without signing in**, a **red banner** explains that you are not logged in and that **Root Record cloud sync / backup** and some plan-gated features stay off until you sign in (**Settings**).
- **Dev icon bootstrap** — **`npm start`** / **`npm run dev`** run **`prepare:icon`** first. If no brand source image is present, a **placeholder** `.ico` is generated so the window is not stuck on the generic Electron icon.

### Changed

- **Guest sessions** — Public **live hazard API** refresh (NOAA / USGS / EONET paths used by manual “refresh” flows) is **throttled**: without an account you get at most **one coordinated refresh burst per 24 hours** (sign in for background schedules and unrestricted manual refresh, per your plan). Pro-only controls (e.g. critical popups / custom sounds) stay locked for guests.
- **Windows** — **`app.setAppUserModelId('com.rootrecord.weather-manager')`** (matches packaged **`appId`**) for **taskbar** identity; **`BrowserWindow` icon** prefers **`nativeImage.createFromPath`** with an absolute **`.ico`** path.

### Fixed

- **Windows** — Taskbar / window icon reliability when **`resources/app-icon.ico`** or **`assets/favicon.ico`** is present.

---

## [1.0.15] - 2026-04-24

### Fixed

- **Earthquakes** - You should now see **the newest earthquakes first** in the list. Older versions could fill the list with the oldest part of the time range first.

### Changed

- **Windows** - The **window and taskbar** should show the correct Root Record icon after install, and **pinning** the app to the taskbar should behave more predictably on Windows 10 and Windows 11.

---

## [1.0.14] - 2026-04-23

### Changed

- **Installer** - On a **first-time** Windows install, the suggested folder is **`C:\Program Files\RootRecord\Weather Manager`**. If you already installed an older build, your **existing** install folder is kept until you pick a different path in the installer.

### Documentation

- **Download site** - Clearer notes on the default install folder and on where **your data** lives under your Windows profile, including what changed if you upgraded from a very early build.

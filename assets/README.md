# App and marketing assets

## Product art (not bundled; design reference for ports)

Files such as **`long-poster-*.png`**, **`long.jpg`**, **`photo_*.png` / `photo_*.jpg`**, and **`github-icon.jpg`** are for **store listings, social, and README** — they are **not** loaded by the Windows/Electron app at runtime. They document **color, composition, and icon style** for anyone porting the product (e.g. **Android / iOS**). The live app uses **`favicon.ico`**, **`installer-sidebar.jpg`**, and the notification sounds under **`notification-sounds-source/`** (see below).

## Runtime and build (Windows / Electron)

`favicon.ico` here is used by the **app and installer** (not shown on the GitHub README). **`npm start`** / **`npm run dev`** run **`prepare:icon`** and **sync alert sounds** first; if no brand source image is in the tree, the script writes a **placeholder** `.ico` so Windows does not fall back to the generic Electron icon.

**Bundled in-repo (portable) sources:** `1qOHn-removebg-preview.png` (app icon from `prepare:icon` → `favicon.ico`), `installer-sidebar.jpg` (NSIS wizard sidebar via `prepare-nsis-sidebar`), and **`notification-sounds-source/`** (MP3s copied into `notification-sounds` by `sync-notification-sounds` — the latter is gitignored build output; run `npm start` or `npm run prepare:assets` after clone). Builds do **not** read assets from other folders; override with **`RR_WEATHER_BRAND_SOURCE`**, **`RR_NSIS_SIDEBAR_SOURCE`**, or **`RR_NOTIFICATION_SOUNDS_SOURCE`** if you need a custom path.

The README **footer** uses the same **RootRecord** mark as the Business Manager download page (loaded from that repo so you do not maintain two copies).

Optional: add **`banner.jpg`** in this folder and reference it at the top of `README.md` if you want a wide hero image like Business Manager’s product banner.

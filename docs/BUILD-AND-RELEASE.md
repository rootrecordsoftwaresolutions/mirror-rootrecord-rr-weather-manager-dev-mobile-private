# Build and release (Windows installer)

`dist/` and `release/` are **not** in Git — they are local outputs from `electron-packager` / **electron-builder**.

## One-line pipeline

1. `npm run prepare:assets` — icons, NSIS **sidebar/ICO** (from `assets/`), `assets/notification-sounds`.
2. `npm run build:installer` — NSIS installer under `release/` (name pattern from `package.json` `build` → e.g. `Root Record Weather Manager-Setup-${version}.exe`).
3. Optional: `npm run build:installer:signed` — runs `scripts/sign-weather-installer.cjs` and **Azure / Authenticode** scripts in `build/` (see [SECURITY-AND-SECRETS.md](./SECURITY-AND-SECRETS.md)).
4. `npm run latest-yml` — (re)writes **`release/latest.yml`**; must match the **bytes** of the final Setup you upload.
5. Publish the **.exe** + **latest.yml** to the **public** download repo: **`RootRecord/rootrecord-weather-manager-download`** on GitHub **Releases** (not this private source repo). Tag typically `v{version}` matching `package.json` `version`.

## In-app updates

- `build/app-update.yml` (copied to **`resources/app-update.yml`** in the app) must keep **`owner`** and **`repo`** correct — today **`RootRecord` / `rootrecord-weather-manager-download`**.

```yaml
# Fragment — see repo file for full
provider: github
owner: RootRecord
repo: rootrecord-weather-manager-download
```

- Users get updates from that **Releases** page. **Never** use the public download org repo as the `git push` target for the full app source; your **private** repo is for that.

## NSIS and assets

- NSIS custom steps: `build/installer.nsh`, generated `build/installerIcon.ico` / `installerSidebar.bmp` (from `scripts/prepare-nsis-*.cjs` + `assets/`).
- `build/artifact_signing_metadata.sample.json` is in Git; **local** `artifact_signing_metadata.json` and Azure tenant file paths are gitignored (see [SECURITY-AND-SECRETS.md](./SECURITY-AND-SECRETS.md)).

## See also

- Root `README` section **For maintainers (releases)** — end-user and marketing checklist.
- **CHANGELOG.md** in repo root for version history text.

# Releasing a version (quick runbook)

Use this with **[BUILD-AND-RELEASE.md](./BUILD-AND-RELEASE.md)** for the full build story.

1. **Version** — set `package.json` `version`, run your build, sign if shipping publicly.
2. **Checksum file** — after the **final** `Setup-*.exe` is produced (and **signed** if you ship signed), run:
   - `npm run latest-yml`
   - so **`release/latest.yml`** matches the exact bytes of that installer.
3. **GitHub Release (download org)** — in **`RootRecord/rootrecord-weather-manager-download`**, create a **Release** (tag e.g. `v1.0.17` matching `version`). Attach the **.exe** and **latest.yml**. Use **[docs/github/](./github/)** for copy-paste release notes, or:
   - `gh release create v1.0.17 --repo RootRecord/rootrecord-weather-manager-download --title "1.0.17" --notes-file docs/github/RELEASE_v1.0.17.md -- target files...`
4. **Verify** — `build/app-update.yml` `owner`/`repo` must match the org repo you published to. Installed clients poll **Releases** via **electron-updater** from that repo.

**Never** `git push` a whole `release/` or `dist/` tree to the **public download** org — only the **Releases** artifacts. This **private** repo holds source.

For detailed steps and signing notes, read [BUILD-AND-RELEASE.md](./BUILD-AND-RELEASE.md) and [SECURITY-AND-SECRETS.md](./SECURITY-AND-SECRETS.md).

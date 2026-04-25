# Private full source (this repository)

**Root Record Weather Manager** is usually developed from a **private** Git remote that contains:

- The **Electron** app (`src/`, `assets/`, `scripts/`, `package.json`, etc.).
- **Developer docs** in **`docs/`** (this folder and linked pages).
- A **.gitignore** that excludes `node_modules/`, `dist/`, `release/`, and machine-local signing secrets.

The **public** [**rootrecord-weather-manager-download**](https://github.com/RootRecord/rootrecord-weather-manager-download) org repository is for **Releases** (the Windows `.exe` and **`latest.yml`**) and a **short** customer README, **not** for `git push` of the full tree. Point **`git remote`** to this private repo for day-to-day work; publish **artifacts** to the public org as described in [BUILD-AND-RELEASE.md](./BUILD-AND-RELEASE.md).

See [REPOSITORY-MAP.md](./REPOSITORY-MAP.md) for a path-by-path overview.

# Developer documentation

These pages are for people (or tools) **shipping or changing** Root Record Weather Manager, not for end users. The product **README** at the repo root is user-facing; start here to build, debug, or plan ports. **Private source vs public download** is described in [PRIVATE-GITHUB-REPOSITORY.md](./PRIVATE-GITHUB-REPOSITORY.md).

| Doc | Use when |
|-----|----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | You need a map of processes, modules, and IPC. |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | First-time setup, environment variables, data locations. |
| [BUILD-AND-RELEASE.md](./BUILD-AND-RELEASE.md) | Build installers, `latest.yml`, and publishing to the public **download** org. |
| [SIGNING-TRUSTED-AZURE.md](./SIGNING-TRUSTED-AZURE.md) | **Authenticode** / **Azure** signing entry points (`build/` scripts, no secrets in Git). |
| [SECURITY-AND-SECRETS.md](./SECURITY-AND-SECRETS.md) | What must not be committed; how secrets are supplied at build or runtime. |
| [PORTING-AND-INTEGRATION.md](./PORTING-AND-INTEGRATION.md) | **Android / iOS** or other stacks: what to re-implement vs reuse conceptually. |
| [REPOSITORY-MAP.md](./REPOSITORY-MAP.md) | Short table of what each top-level path is for. |
| [RELEASE.md](./RELEASE.md) | **Quick** `gh` / Release checklist; deep detail in *Build and release*. |
| [github/](./github/) | Copy-paste text for the **public download** org’s Release page. |

`assets/README.md` explains **which image files** are marketing-only versus bundled with the app.

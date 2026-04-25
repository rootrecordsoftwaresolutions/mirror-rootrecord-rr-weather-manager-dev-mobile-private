# Security & secrets (internal) — Root Record Weather Manager

Even a **private** repository should not become a second backup of **long-lived keys**. This document lists what the **.gitignore** and team practice are protecting.

| Item | Location | In git? | Notes |
|------|-----------|---------|--------|
| `node_modules/` | (root) | **No** | Reproducible from `package-lock.json` + `npm ci`. |
| `release/`, `dist/`, `win-unpacked/`, `*.blockmap` | app root / output | **No** | Rebuild from scripts; contains signed PEs. |
| `build/artifact_signing_metadata.json` | `build/` | **No** (local copy from sample) | **Azure** Trusted Signing metadata; can reference account/region. |
| `build/azure_tenant_id.txt` | `build/` | **No** | **Optional** tenant hint for `az` login. |
| `build/installerIcon.ico`, `build/installerSidebar.bmp` | `build/` | **No** | **Generated** by `npm run prepare:assets` from `assets/`. |
| `assets/notification-sounds/` | `assets/` | **No** | Filled from `assets/notification-sounds-source/`. |
| `*.log`, `*.err` | anywhere | **No** | Noisy, may include paths. |
| `.env` (if used) | root | **No** | Use `.env.example` in another product if you standardize. |
| Partner Center / Store | N/A | **N/A** | **Never** paste PFX, MSIX **secrets**, or partner tokens in issues or code. |

**Rotation:** If a **secret** or **PAT** was ever in a public place (including a mis-targeted `git push`), **rotate** it; private repo access does not undo a leak from an earlier public exposure.

**Signing script:** The vendored `build/sign_release_azure.ps1` is a **portable** copy; update from your **authoritative** internal tree when the signing pipeline changes, then commit the diff to the private repo.

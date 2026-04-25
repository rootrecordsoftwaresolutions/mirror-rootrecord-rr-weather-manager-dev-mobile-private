# Security and secrets

## What must not be in Git

- **`.env`** and any file containing **API keys**, **bearer tokens**, or **connection strings** for live services.
- **Firebase** `*adminsdk*.json` or any **service account** JSON.
- **Azure** signing: `build/artifact_signing_metadata.json` and `build/azure_tenant_id.txt` (if used) — the repo has **`artifact_signing_metadata.sample.json`** as a safe template. Real metadata stays on the build machine.
- **Local** build outputs: `build/output/` (ignored).

The repository **.gitignore** is configured to exclude these patterns; double-check with `git status` before any push.

## Runtime and CI secrets

- **`LICENSE_API_SECRET`** (and similar) should be set in **the OS environment** or a **CI secret store**, not committed.
- The **shipped** license **Worker** URL in code is public; the **shared** bearer is the sensitive part. Rotate if leaked.

## Signing and publishing

- Windows releases should use a **known** code-signing pipeline (`build/sign_release_azure.ps1` / `sign-weather-installer.cjs` as wired in this project). Unpublished binaries for testing may skip signing, but do not ship unlabeled binaries to customers.

## For mobile / other stacks

- Do not embed a **bearer** or **client secret** in a store app. Mobile clients should use whatever token model your backend defines (OAuth, per-device) — the Electron app’s env-based secrets are a **desktop** model.

## Reporting

- If you find credentials in a commit, **rotate** the credential, **remove** the blob from history (BFG or `git filter-repo`) if the repo is public, and re-push.

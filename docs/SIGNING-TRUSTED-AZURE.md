# Windows signing (Azure Trusted Signing)

Production installers for Root Record are typically **Authenticode**-signed on Windows.

## Where it lives in this repo

- **`build/sign_release_azure.ps1`** and **`build/sign_release_azure.cmd`** — main flow for **signing build outputs**; read the script header and in-file comments for parameters. **`npm run build:installer:signed`** wires **`sign-weather-installer.cjs`** to call into this after NSIS.
- **`build/artifact_signing_metadata.sample.json`** — shape of the **metadata** file used by the signing process. Copy to **`build/artifact_signing_metadata.json`** (gitignored) on the machine that signs; do **not** commit the real file.
- **Optional** Inno/ISCC hook — if you add Inno, you may use a local **`build/sign_inno_azure.ps1`** (not required for the stock **NSIS** pipeline here). Keep any such file **out of Git** if it embeds account-specific notes; NSIS is the default installer target.

## Credentials

Azure Trusted Signing and related IDs belong in your **dev machine or CI** secret store. See [SECURITY-AND-SECRETS.md](./SECURITY-AND-SECRETS.md). Never open a PR with tenant IDs, tokens, or the real `artifact_signing_metadata.json`.

## Testing

Unsigned builds are fine for internal QA. Anything broad-facing should go through the same process you use for other Root Record Windows products so SmartScreen and enterprise policies see a consistent publisher.

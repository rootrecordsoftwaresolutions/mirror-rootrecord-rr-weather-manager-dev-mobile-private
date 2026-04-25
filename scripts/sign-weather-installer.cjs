'use strict';

/**
 * Post-signs Weather Manager NSIS + win-unpacked PE files using this repo’s
 * `build/sign_release_azure.ps1` (vendored; no sibling project required).
 *
 * Script resolution: RR_SIGN_SCRIPT full or project-relative path,
 * or RR_AZURE_SIGN_ROOT / RR_SIGN_REPO_ROOT (repo root containing `build/`), or `./build/sign_release_azure.ps1`.
 * Prerequisites: see docs/SIGNING-TRUSTED-AZURE.md — Artifact Signing tools, SDK signtool, az login.
 * Metadata: build/artifact_signing_metadata.json next to the .ps1 (or ARTIFACT_SIGNING_METADATA env).
 * If the JSON is missing, this script copies build/artifact_signing_metadata.sample.json -> .json (gitignored) before invoking PowerShell.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Azure signing driver expects `build/artifact_signing_metadata.json`. If absent, clone from
 * `artifact_signing_metadata.sample.json` (same as manual copy) so a fresh clone can sign without an extra step.
 * Skips when ARTIFACT_SIGNING_METADATA points at an existing file.
 */
function ensureArtifactSigningMetadata(projectRoot) {
  if (String(process.env.ARTIFACT_SIGNING_METADATA || '').trim()) {
    return;
  }
  const buildDir = path.join(projectRoot, 'build');
  const target = path.join(buildDir, 'artifact_signing_metadata.json');
  const sample = path.join(buildDir, 'artifact_signing_metadata.sample.json');
  if (fs.existsSync(target)) return;
  if (!fs.existsSync(sample)) {
    throw new Error(
      'Missing build/artifact_signing_metadata.json and build/artifact_signing_metadata.sample.json. Restore the sample from the repo.'
    );
  }
  fs.copyFileSync(sample, target);
  console.log(
    '[sign-weather] Created build/artifact_signing_metadata.json from the sample (edit for your Azure account or set ARTIFACT_SIGNING_METADATA).'
  );
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function findSignScript(projectRoot) {
  const fileName = 'sign_release_azure.ps1';
  const inBuild = path.join(projectRoot, 'build', fileName);

  const fromEnv = String(process.env.RR_SIGN_SCRIPT || '').trim();
  if (fromEnv) {
    const p = path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot, fromEnv);
    if (fs.existsSync(p)) return path.resolve(p);
  }
  const envRoot = String(process.env.RR_AZURE_SIGN_ROOT || process.env.RR_SIGN_REPO_ROOT || '').trim();
  if (envRoot) {
    const root = path.resolve(envRoot);
    const p = path.join(root, 'build', fileName);
    if (fs.existsSync(p)) return path.resolve(p);
  }
  if (fs.existsSync(inBuild)) return path.resolve(inBuild);
  return null;
}

function collectSignTargets(releaseDir) {
  const targets = [];
  const unpacked = path.join(releaseDir, 'win-unpacked');
  if (fs.existsSync(unpacked)) {
    const stack = [unpacked];
    while (stack.length) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.exe' || ext === '.dll' || ext === '.node') targets.push(full);
      }
    }
  }
  if (fs.existsSync(releaseDir)) {
    const setups = fs
      .readdirSync(releaseDir)
      .filter((name) => /Setup.*\.exe$/i.test(name))
      .map((name) => {
        const full = path.join(releaseDir, name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (setups.length) targets.push(setups[0].full);
  }
  return targets;
}

function killWeatherManagerProcesses(projectRoot) {
  if (process.platform !== 'win32') return;
  spawnSync('cmd.exe', ['/c', 'taskkill /F /IM RootRecordWeatherManager.exe /T 1>nul 2>nul'], { stdio: 'ignore' });
  const releaseDir = path.join(projectRoot, 'release');
  if (fs.existsSync(releaseDir)) {
    for (const name of fs.readdirSync(releaseDir)) {
      if (!/Setup.*\.exe$/i.test(name)) continue;
      spawnSync('taskkill', ['/F', '/IM', name, '/T'], { stdio: 'ignore' });
    }
  }
  spawnSync('cmd.exe', ['/c', 'timeout /t 1 /nobreak 1>nul'], { stdio: 'ignore' });
}

function removeStaleBlockmaps(releaseDir) {
  if (!fs.existsSync(releaseDir)) return;
  for (const name of fs.readdirSync(releaseDir)) {
    if (!name.toLowerCase().endsWith('.exe.blockmap')) continue;
    try {
      fs.unlinkSync(path.join(releaseDir, name));
    } catch {
      /* ignore */
    }
  }
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const releaseDir = path.join(projectRoot, 'release');

  ensureArtifactSigningMetadata(projectRoot);

  const signScript = findSignScript(projectRoot);
  if (!signScript) {
    const local = path.join(projectRoot, 'build', 'sign_release_azure.ps1');
    throw new Error(
      'Signing script not found. Vendored copy: ' +
        local +
        ' (or set RR_SIGN_SCRIPT=path to sign_release_azure.ps1, or RR_AZURE_SIGN_ROOT=repo root that contains build/).' +
        ' See docs/SIGNING-TRUSTED-AZURE.md.'
    );
  }

  const targets = collectSignTargets(releaseDir);
  if (!targets.length) {
    throw new Error(`No signable files under ${releaseDir}. Run npm run build:installer first.`);
  }

  killWeatherManagerProcesses(projectRoot);

  const extrasListPath = path.join(os.tmpdir(), `rr-weather-sign-targets-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(extrasListPath, `${targets.join('\n')}\n`, 'utf8');

  const signRepoRoot = path.resolve(signScript, '..', '..');
  try {
    runOrThrow('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      signScript,
      '-SkipExe',
      '-SkipInstaller',
      '-StopRunningApp',
      '-ExtraFilesListPath',
      extrasListPath
    ], { cwd: signRepoRoot });
  } finally {
    try {
      fs.unlinkSync(extrasListPath);
    } catch {
      /* ignore */
    }
  }

  removeStaleBlockmaps(releaseDir);
  console.log(`Signed ${targets.length} file(s). Removed stale *.exe.blockmap in release/ (checksums no longer match the signed installer).`);
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}

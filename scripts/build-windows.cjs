const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const packager = require('electron-packager');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveAsideIfLocked(targetDir) {
  if (!fs.existsSync(targetDir)) return null;
  const parent = path.dirname(targetDir);
  const backupName = path.basename(targetDir) + `.rr-bak-${Date.now()}`;
  const backupPath = path.join(parent, backupName);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      fs.renameSync(targetDir, backupPath);
      return backupPath;
    } catch (error) {
      if (!fs.existsSync(targetDir)) return null;
      if (attempt === 8) throw error;
      await sleep(1000);
    }
  }
  return null;
}

function removeBackupDir(backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) return;
  try {
    fs.rmSync(backupPath, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup failure.
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const outDir = path.join(projectRoot, 'dist');
  const appOutDir = path.join(outDir, 'RootRecordWeatherManager-win32-x64');
  fs.mkdirSync(outDir, { recursive: true });
  const backupDir = await moveAsideIfLocked(appOutDir);

  try {
    const prep = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'prepare-weather-assets.cjs')], {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    if (prep.status !== 0) {
      throw new Error('prepare-weather-assets.cjs failed');
    }
    const soundSync = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'sync-notification-sounds.cjs')], {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    if (soundSync.status !== 0) {
      throw new Error('sync-notification-sounds.cjs failed');
    }

    const iconIco = path.join(projectRoot, 'assets', 'favicon.ico');
    const packOpts = {
      dir: projectRoot,
      out: outDir,
      overwrite: true,
      platform: 'win32',
      arch: 'x64',
      asar: true,
      prune: true,
      appCopyright: 'Root Record',
      name: 'RootRecordWeatherManager',
      executableName: 'RootRecordWeatherManager',
      ignore: [
        /^\/dist($|\/)/,
        /^\/scripts($|\/)/,
        /^\/build($|\/)/,
        /^\/image.*\.jpg$/i,
        /^\/i1GHr\.jpg$/i
      ]
    };
    if (fs.existsSync(iconIco)) {
      packOpts.icon = iconIco;
    }

    const appPaths = await packager(packOpts);

    console.log('Build complete:');
    for (const appPath of appPaths) {
      console.log(`- ${appPath}`);
    }

    const resourcesDir = path.join(appOutDir, 'resources');
    const updateYmlSrc = path.join(projectRoot, 'build', 'app-update.yml');
    const updateYmlDst = path.join(resourcesDir, 'app-update.yml');
    if (!fs.existsSync(updateYmlSrc)) {
      throw new Error(`Missing ${updateYmlSrc}`);
    }
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.copyFileSync(updateYmlSrc, updateYmlDst);
    console.log(`Copied app-update.yml -> ${updateYmlDst}`);

    const notifSrc = path.join(projectRoot, 'assets', 'notification-sounds');
    const notifDst = path.join(resourcesDir, 'notification-sounds');
    if (fs.existsSync(notifSrc)) {
      fs.cpSync(notifSrc, notifDst, { recursive: true });
      console.log(`Copied notification sounds -> ${notifDst}`);
    } else {
      console.warn(
        'No assets/notification-sounds (run: npm run prepare:icon && node scripts/sync-notification-sounds.cjs or npm run prepare:assets)'
      );
    }
  } finally {
    removeBackupDir(backupDir);
  }
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exitCode = 1;
});

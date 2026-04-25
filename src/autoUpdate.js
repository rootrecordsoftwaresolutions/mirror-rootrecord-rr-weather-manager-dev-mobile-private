'use strict';

const { BrowserWindow, dialog } = require('electron');

/** 4 hours — same idea as periodic sync; keeps long-running installs aware of GitHub releases. */
const PERIODIC_UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
/** First check after launch (matches Business Manager). */
const INITIAL_UPDATE_CHECK_DELAY_MS = 6000;

let updaterRef = null;
let periodicTimer = null;

/**
 * True when the app is running from a Microsoft Store / MSIX-style install (under WindowsApps).
 */
function isMicrosoftStoreLayoutInstall(app) {
  if (process.platform !== 'win32' || !app || !app.isPackaged) return false;
  try {
    const exe = app.getPath('exe') || '';
    return /\\WindowsApps\\/i.test(exe) || /\/WindowsApps\//i.test(exe);
  } catch {
    return false;
  }
}

function isAutoUpdateDisabled(app) {
  if (!app.isPackaged) return true;
  if (process.argv.includes('--no-update-check')) return true;
  if (String(process.env.RR_DISABLE_AUTO_UPDATE || '').trim() === '1') return true;
  if (isMicrosoftStoreLayoutInstall(app)) return true;
  return false;
}

/**
 * GitHub Releases updates via electron-updater.
 *
 * Packaged apps include `resources/app-update.yml` → provider **github**,
 * **RootRecord/rootrecord-weather-manager-download** (same release pattern as Business Manager:
 * signed NSIS installer + `latest.yml` on each GitHub release).
 *
 * Runs only when packaged; skipped in dev / `--no-update-check` / Store layout / `RR_DISABLE_AUTO_UPDATE=1`.
 * Also runs a background check every few hours after the first post-launch check.
 */
function setupAutoUpdater(app, getMainWindow) {
  if (isAutoUpdateDisabled(app)) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }

  updaterRef = autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('error', (err) => {
    console.warn('[autoUpdater]', err && err.message ? err.message : err);
  });

  autoUpdater.on('update-available', async (info) => {
    const ver = info && info.version ? String(info.version) : 'newer';
    const parent = getMainWindow && getMainWindow() ? getMainWindow() : BrowserWindow.getFocusedWindow();
    const { response } = await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      title: 'Update available',
      message: `RootRecord Weather Manager ${ver} is available.`,
      detail: 'Download and install when you are ready.',
      buttons: ['Download', 'Not now'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (e) {
        dialog.showErrorBox('Update failed', e && e.message ? e.message : String(e));
      }
    }
  });

  autoUpdater.on('update-downloaded', async () => {
    const parent = getMainWindow && getMainWindow() ? getMainWindow() : BrowserWindow.getFocusedWindow();
    const { response } = await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      title: 'Update ready',
      message: 'Restart now to finish installing the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, INITIAL_UPDATE_CHECK_DELAY_MS);

  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, PERIODIC_UPDATE_CHECK_MS);

  app.once('will-quit', () => {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
    updaterRef = null;
  });
}

/**
 * Manual check from About (or IPC). Shows “up to date” or error when nothing to install.
 * When an update exists, `update-available` handler shows the same Download dialog as automatic checks.
 */
async function checkForUpdatesInteractive(app, getMainWindow) {
  const parent = getMainWindow && getMainWindow() ? getMainWindow() : BrowserWindow.getFocusedWindow();

  if (!app.isPackaged) {
    await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      title: 'Software update',
      message: 'Update checks run in the installed Windows app.',
      detail:
        'This is a development launch. Install a release from GitHub (RootRecord/rootrecord-weather-manager-download) for automatic updates.',
      buttons: ['OK']
    });
    return { ok: false, reason: 'not_packaged' };
  }

  if (process.argv.includes('--no-update-check') || String(process.env.RR_DISABLE_AUTO_UPDATE || '').trim() === '1') {
    await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      title: 'Software update',
      message: 'Automatic updates are turned off for this launch.',
      buttons: ['OK']
    });
    return { ok: false, reason: 'disabled' };
  }

  if (isMicrosoftStoreLayoutInstall(app)) {
    await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      title: 'Software update',
      message: 'This install is updated through the Microsoft Store.',
      buttons: ['OK']
    });
    return { ok: false, reason: 'store_layout' };
  }

  if (!updaterRef) {
    await dialog.showMessageBox(parent || undefined, {
      type: 'warning',
      title: 'Software update',
      message: 'The update system is not active in this build.',
      buttons: ['OK']
    });
    return { ok: false, reason: 'no_updater' };
  }

  try {
    const result = await updaterRef.checkForUpdates();
    const has =
      (result && result.isUpdateAvailable === true) ||
      (result &&
        result.updateInfo &&
        result.updateInfo.version &&
        String(result.updateInfo.version) !== String(app.getVersion()));
    if (!has) {
      await dialog.showMessageBox(parent || undefined, {
        type: 'info',
        title: 'Software update',
        message: 'You’re on the latest RootRecord Weather Manager.',
        detail: 'Releases: GitHub → RootRecord/rootrecord-weather-manager-download',
        buttons: ['OK']
      });
    }
    return { ok: true, isUpdateAvailable: Boolean(has) };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    await dialog.showMessageBox(parent || undefined, {
      type: 'warning',
      title: 'Update check failed',
      message: msg,
      buttons: ['OK']
    });
    return { ok: false, error: msg };
  }
}

module.exports = { setupAutoUpdater, checkForUpdatesInteractive };

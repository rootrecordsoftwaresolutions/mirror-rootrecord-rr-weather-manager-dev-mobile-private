'use strict';

/**
 * Writes build/installerIcon.ico for electron-builder NSIS (wizard / uninstall title bar).
 *
 * Default: copy assets/favicon.ico (same as win.icon, BrowserWindow, and the embedded .exe resource).
 * prepare-weather-assets.cjs must run first in the same `prepare:assets` chain to generate that favicon
 * from assets/1qOHn-removebg-preview.png (or RR_WEATHER_BRAND_SOURCE) via prepare-weather-assets.
 *
 * Optional override: RR_NSIS_INSTALLER_ICON_SOURCE — absolute or project-relative raster (png/jpg/webp).
 * When set, regenerates a multi-size .ico from that file to build/installerIcon.ico and overwrites
 * assets/favicon.ico so the NSIS art, the portable/packaged .exe, and the window agree.
 */

const fs = require('fs');
const path = require('path');
const { writeWinMultiSizeIco } = require('./win-ico-from-image.cjs');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const outPath = path.join(projectRoot, 'build', 'installerIcon.ico');
  const favicon = path.join(projectRoot, 'assets', 'favicon.ico');

  const envSrc = String(process.env.RR_NSIS_INSTALLER_ICON_SOURCE || '').trim();

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('[prepare-nsis-installer-icon] sharp is required. Run: npm install');
    process.exit(1);
  }

  if (envSrc) {
    const src = path.isAbsolute(envSrc) ? envSrc : path.join(projectRoot, envSrc);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw new Error(`RR_NSIS_INSTALLER_ICON_SOURCE not found or not a file: ${src}`);
    }
    await writeWinMultiSizeIco(sharp, src, outPath, { fit: 'cover', position: 'centre' });
    fs.mkdirSync(path.dirname(favicon), { recursive: true });
    fs.copyFileSync(outPath, favicon);
    console.log(
      '[prepare-nsis-installer-icon] Wrote',
      path.relative(projectRoot, outPath),
      'and synced',
      path.relative(projectRoot, favicon),
      'from',
      path.relative(projectRoot, src)
    );
    return;
  }

  if (!fs.existsSync(favicon)) {
    throw new Error(
      `assets/favicon.ico is missing. Run: npm run prepare:icon (or the full prepare:assets chain) so ` +
        `assets/favicon.ico is generated before the NSIS step — expected source: ` +
        path.join('assets', '1qOHn-removebg-preview.png')
    );
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(favicon, outPath);
  console.log(
    '[prepare-nsis-installer-icon] Copied',
    path.relative(projectRoot, favicon),
    '->',
    path.relative(projectRoot, outPath),
    '(one icon for .exe, shortcuts, taskbar, and installer).'
  );
}

main().catch((e) => {
  console.error('[prepare-nsis-installer-icon]', e.message || e);
  process.exit(1);
});

'use strict';

/**
 * Builds build/installerSidebar.bmp for electron-builder NSIS (MUI welcome / finish / uninstall sidebar).
 * Required size per electron-builder: 164 × 314 pixels.
 *
 * Source (first that exists):
 *   1) RR_NSIS_SIDEBAR_SOURCE — absolute or project-relative image path
 *   2) assets/installer-sidebar.jpg — in-repo (portable; ships with the project)
 */

const fs = require('fs');
const path = require('path');

const WIDTH = 164;
const HEIGHT = 314;

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const outPath = path.join(projectRoot, 'build', 'installerSidebar.bmp');

  const envSrc = String(process.env.RR_NSIS_SIDEBAR_SOURCE || '').trim();
  const inRepoImage = path.join(projectRoot, 'assets', 'installer-sidebar.jpg');
  const src = envSrc
    ? path.isAbsolute(envSrc)
      ? envSrc
      : path.join(projectRoot, envSrc)
    : inRepoImage;

  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    console.warn('[prepare-nsis-sidebar] sharp not available — cannot write installer sidebar.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (!fs.existsSync(src)) {
    console.warn('[prepare-nsis-sidebar] Source image not found:', src);
    console.warn('[prepare-nsis-sidebar] Writing solid placeholder BMP so NSIS build can proceed.');
    await sharp({
      create: {
        width: WIDTH,
        height: HEIGHT,
        channels: 3,
        background: { r: 30, g: 58, b: 95 }
      }
    }).toFile(outPath);
    return;
  }

  await sharp(src).resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' }).toFile(outPath);

  console.log('[prepare-nsis-sidebar] Wrote', path.relative(projectRoot, outPath), `(${WIDTH}×${HEIGHT}) from`, path.relative(projectRoot, src));
}

main().catch((e) => {
  console.error('[prepare-nsis-sidebar]', e.message || e);
  process.exit(1);
});

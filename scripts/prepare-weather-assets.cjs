'use strict';

/**
 * Generates assets/favicon.ico for electron-packager (Windows .exe icon).
 *
 * Source image resolution order (Sharp-supported raster, e.g. png/jpg):
 *   1) RR_WEATHER_BRAND_SOURCE (absolute or project-relative path)
 *   2) assets/1qOHn-removebg-preview.png — in-repo (portable; copy stays with the project)
 *   3) assets/source.jpg, assets/brand.jpg
 *   4) First *.jpg in project root matching /^image.*\\.jpg$/i or i1GHr.jpg (legacy drops)
 *
 * Requires devDependency: sharp. If missing, skips with a message (exit 0).
 *
 * favicon.ico is 32bpp DIB+XOR+AND only (no PNG-in-ICO). Icon directory entries MUST be in
 * strictly ascending size order or Windows can render a bad shell icon.
 * Optional: set RR_USE_IMAGEMAGICK_ICO=1 and install ImageMagick (`magick` on PATH) to write
 * the .ico with ImageMagick instead (good escape hatch if our encoder ever disagrees with a tool).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeWinMultiSizeIco } = require('./win-ico-from-image.cjs');

function tryWriteIcoWithImageMagick(srcJpg, outIco) {
  const use = String(process.env.RR_USE_IMAGEMAGICK_ICO || '').trim().toLowerCase();
  if (use !== '1' && use !== 'true' && use !== 'yes') return false;
  const magick = process.platform === 'win32' ? 'magick.exe' : 'magick';
  const args = [
    'convert',
    srcJpg,
    '-alpha',
    'on',
    '-define',
    'icon:auto-resize=256,128,96,64,48,40,32,24,20,16',
    outIco
  ];
  const r = spawnSync(magick, args, { stdio: 'pipe' });
  if (r.status !== 0 || !fs.existsSync(outIco) || fs.statSync(outIco).size < 64) {
    if (r.stderr && r.stderr.length) {
      console.warn('[prepare-weather-assets] ImageMagick ICO failed:', r.stderr.toString().trim());
    }
    return false;
  }
  console.log('[prepare-weather-assets] ICO generated via ImageMagick (RR_USE_IMAGEMAGICK_ICO).');
  return true;
}

async function writeFaviconIcoFromSource(sharpFactory, src, outPath) {
  if (tryWriteIcoWithImageMagick(src, outPath)) {
    return;
  }
  await writeWinMultiSizeIco(sharpFactory, src, outPath, { fit: 'cover', position: 'centre' });
}

function projectRoot() {
  return path.resolve(__dirname, '..');
}

function findBrandSourceImage(root) {
  const env = String(process.env.RR_WEATHER_BRAND_SOURCE || '').trim();
  if (env) {
    const abs = path.isAbsolute(env) ? env : path.join(root, env);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  const inRepoBrandPng = path.join(root, 'assets', '1qOHn-removebg-preview.png');
  if (fs.existsSync(inRepoBrandPng) && fs.statSync(inRepoBrandPng).isFile()) {
    return inRepoBrandPng;
  }
  for (const rel of ['assets/source.jpg', 'assets/brand.jpg']) {
    const p = path.join(root, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const loose = names.filter(
    (n) =>
      (n.toLowerCase().endsWith('.jpg') && /^image.*\.jpg$/i.test(n)) || /^i1ghr\.jpg$/i.test(n)
  );
  loose.sort((a, b) => {
    const pri = (n) => (n.toLowerCase() === 'image.jpg' ? 0 : 1);
    const pa = pri(a);
    const pb = pri(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
  for (const n of loose) {
    const p = path.join(root, n);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  const legacy = path.join(root, 'image.jpg');
  if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) return legacy;
  return null;
}

async function main() {
  const root = projectRoot();
  const assetsDir = path.join(root, 'assets');
  const faviconPath = path.join(assetsDir, 'favicon.ico');

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.warn('[prepare-weather-assets] sharp not installed; skipping ICO/BMP generation. Run: npm install');
    process.exit(0);
  }

  const src = findBrandSourceImage(root);
  if (!src) {
    if (fs.existsSync(faviconPath)) {
      console.log('[prepare-weather-assets] Using existing assets/favicon.ico (no brand source image found).');
      process.exit(0);
    }
    fs.mkdirSync(assetsDir, { recursive: true });
    const tmpPng = path.join(assetsDir, '.weather-app-icon-placeholder.png');
    try {
      /** Teal tile distinct from Electron’s default; replaced when a brand source image is added. */
      const rgba = await sharp({
        create: {
          width: 512,
          height: 512,
          channels: 4,
          background: { r: 46, g: 122, b: 138, alpha: 1 }
        }
      })
        .png()
        .toBuffer();
      fs.writeFileSync(tmpPng, rgba);
      await writeFaviconIcoFromSource(sharp, tmpPng, faviconPath);
      console.log(
        '[prepare-weather-assets] Wrote placeholder',
        path.relative(root, faviconPath),
        '(add assets/1qOHn-removebg-preview.png, assets/source.jpg, or set RR_WEATHER_BRAND_SOURCE for your mark).'
      );
    } catch (e) {
      console.warn(
        '[prepare-weather-assets] No brand source and could not write placeholder ICO:',
        e && e.message ? e.message : e
      );
    } finally {
      try {
        if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }

  fs.mkdirSync(assetsDir, { recursive: true });

  await writeFaviconIcoFromSource(sharp, src, faviconPath);
  console.log('[prepare-weather-assets] Wrote', path.relative(root, faviconPath), 'from', path.relative(root, src));
}

main().catch((e) => {
  console.error('[prepare-weather-assets]', e && e.message ? e.message : e);
  process.exit(1);
});

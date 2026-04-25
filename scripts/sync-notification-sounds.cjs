'use strict';

/**
 * Copies shipped alert clips into assets/notification-sounds for main.js (see get-alert-sounds scan order).
 *
 * Source resolution:
 *   1) RR_NOTIFICATION_SOUNDS_SOURCE — absolute or project-relative path to a folder of audio files
 *   2) assets/notification-sounds-source — in-repo (portable; required for a standalone clone)
 *
 * Dest: assets/notification-sounds
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const destDir = path.join(projectRoot, 'assets', 'notification-sounds');

const envSrc = String(process.env.RR_NOTIFICATION_SOUNDS_SOURCE || '').trim();
const allowed = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);

function pickSourceDir() {
  if (envSrc) {
    return path.isAbsolute(envSrc) ? envSrc : path.join(projectRoot, envSrc);
  }
  const inRepo = path.join(projectRoot, 'assets', 'notification-sounds-source');
  if (fs.existsSync(inRepo) && fs.statSync(inRepo).isDirectory()) {
    const hasAudio = fs.readdirSync(inRepo, { withFileTypes: true }).some(
      (d) => d.isFile() && allowed.has(path.extname(d.name).toLowerCase())
    );
    if (hasAudio) return inRepo;
  }
  return null;
}

const srcDir = pickSourceDir();
const placeholderName = '.rr-no-sounds-bundled';

function main() {
  fs.mkdirSync(destDir, { recursive: true });
  const placeholderPath = path.join(destDir, placeholderName);

  if (!srcDir || !fs.existsSync(srcDir)) {
    console.log(
      '[sync-notification-sounds] No source folder (use assets/notification-sounds-source or RR_NOTIFICATION_SOUNDS_SOURCE):',
      srcDir || '(none)'
    );
    fs.writeFileSync(placeholderPath, '');
    process.exit(0);
  }
  const st = fs.statSync(srcDir);
  if (!st.isDirectory()) {
    console.warn('[sync-notification-sounds] Source is not a directory:', srcDir);
    fs.writeFileSync(placeholderPath, '');
    process.exit(0);
  }

  if (fs.existsSync(placeholderPath)) {
    try {
      fs.unlinkSync(placeholderPath);
    } catch {
      /* ignore */
    }
  }
  let copied = 0;
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!allowed.has(ext)) continue;
    fs.copyFileSync(path.join(srcDir, ent.name), path.join(destDir, ent.name));
    copied += 1;
  }
  console.log('[sync-notification-sounds] Copied', copied, 'file(s) ->', path.relative(projectRoot, destDir));
}

main();

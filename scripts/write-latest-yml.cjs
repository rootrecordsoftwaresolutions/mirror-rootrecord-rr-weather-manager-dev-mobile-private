'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || require('../package.json').version;
const releaseDir = path.join(__dirname, '..', 'release');
const artifactName = `Root Record Weather Manager-Setup-${version}.exe`;
/** `gh release create` / `gh release upload` store this asset with dots instead of spaces in the product name segment. */
function githubDownloadAssetName(localArtifactName) {
  return localArtifactName.replace(/^Root Record Weather Manager(?=-)/, 'Root.Record.Weather.Manager');
}
const fp = path.join(releaseDir, artifactName);
if (!fs.existsSync(fp)) {
  console.error('Missing:', fp);
  process.exit(1);
}
const buf = fs.readFileSync(fp);
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const urlName = githubDownloadAssetName(artifactName);
const yml =
  `version: ${version}\n` +
  `files:\n` +
  `  - url: ${urlName}\n` +
  `    sha512: ${sha512}\n` +
  `    size: ${buf.length}\n` +
  `path: ${urlName}\n` +
  `sha512: ${sha512}\n` +
  `releaseDate: '${new Date().toISOString()}'\n`;
const out = path.join(releaseDir, 'latest.yml');
fs.writeFileSync(out, yml, 'utf8');
console.log('Wrote', out, 'size', buf.length);

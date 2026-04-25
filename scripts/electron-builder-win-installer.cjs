'use strict';

/**
 * Runs electron-builder for the Windows NSIS target with code-signing auto-discovery off.
 * Avoids downloading/extracting winCodeSign on machines where 7-Zip cannot create
 * symlinks (common without Developer Mode / SeCreateSymbolicLinkPrivilege).
 */

const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const r = spawnSync(
  process.execPath,
  [path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--publish', 'never'],
  { cwd: projectRoot, stdio: 'inherit', env: process.env }
);

if (r.error) throw r.error;
process.exit(r.status == null ? 1 : r.status);

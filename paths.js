'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Where bot settings, ledger, calibration, and credentials are stored.
 *
 * On Render's free/ephemeral disk, anything under the app directory is wiped
 * on restart/deploy — which makes dashboard settings look like they "reset".
 * Set DATA_DIR to a Persistent Disk mount (e.g. /var/data) so state survives.
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'archive'), { recursive: true });
}

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

module.exports = {
  DATA_DIR,
  ensureDataDir,
  dataPath,
};

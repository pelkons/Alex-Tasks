#!/usr/bin/env node
'use strict';
// Encrypted consistent copy of the live database:  node scripts/backup-db.js <destination.db>
// Used by deploy/backup.sh and scripts/deploy.sh. The copy is encrypted with the same key as the database.
const path = require('path');
const { loadKey } = require('../lib/dbkey');
const { backupTo } = require('../lib/dbtools');
const dest = process.argv[2];
if (!dest) { console.error('usage: backup-db.js <destination.db>'); process.exit(2); }
const src = process.env.MESIMOT_DB || path.join(__dirname, '..', 'data', 'mesimot.db');
const hex = loadKey();
if (!hex) { console.error('no key file: nothing is encrypted yet, run scripts/encrypt-db.js first'); process.exit(3); }
fs_mkdir(path.dirname(path.resolve(dest)));
backupTo(src, path.resolve(dest), hex);
console.log('encrypted backup written:', dest);
function fs_mkdir(d) { require('fs').mkdirSync(d, { recursive: true }); }

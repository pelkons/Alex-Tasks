#!/usr/bin/env node
'use strict';
// one-off / repeatable: read the stored raw files of the emails that have no HTML yet; keeps the original HTML and the inline pictures. Prints the counts.
const { open } = require('../lib/db');
const db = open(process.env.MESIMOT_DB || require('path').join(__dirname, '..', 'data', 'mesimot.db'));
require('../lib/mailview').createMailView(db).backfill({ log: console.log }).then((c) => { console.log('done', c); process.exit(0); });

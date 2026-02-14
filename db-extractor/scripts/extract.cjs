#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const _fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { runAsyncSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('db', { alias: 'd', type: 'string', demandOption: true })
  .option('query', {
    alias: 'q',
    type: 'string',
    default: 'SELECT * FROM sqlite_master WHERE type="table"',
  })
  .option('out', { alias: 'o', type: 'string' }).argv;

runAsyncSkill('db-extractor', async () => {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(argv.db);

    db.serialize(() => {
      db.all(argv.query, (err, rows) => {
        db.close();

        if (err) {
          reject(err);
          return;
        }

        if (argv.out) {
          const output = JSON.stringify(rows, null, 2);
          safeWriteFile(argv.out, output);
          resolve({ output: argv.out, rowCount: rows.length });
        } else {
          resolve({ rows, rowCount: rows.length });
        }
      });
    });
  });
});

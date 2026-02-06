#!/usr/bin/env node
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('db', { alias: 'd', type: 'string', demandOption: true })
    .option('query', { alias: 'q', type: 'string', default: 'SELECT * FROM sqlite_master WHERE type="table"' })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

const db = new sqlite3.Database(argv.db);

db.serialize(() => {
    db.all(argv.query, (err, rows) => {
        if (err) {
            console.error("Query Error:", err.message);
            process.exit(1);
        }
        
        const output = JSON.stringify(rows, null, 2);
        if (argv.out) {
            fs.writeFileSync(argv.out, output);
            console.log(`Extracted data to: ${argv.out}`);
        } else {
            console.log(output);
        }
    });
});

db.close();
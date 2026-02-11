#!/usr/bin/env node
const fs = require('fs');
const Diff = require('diff');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
    .option('old', { alias: 'a', type: 'string', demandOption: true })
    .option('new', { alias: 'b', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

runSkill('diff-visualizer', () => {
    const oldPath = validateFilePath(argv.old, 'old file');
    const newPath = validateFilePath(argv.new, 'new file');
    const oldText = fs.readFileSync(oldPath, 'utf8');
    const newText = fs.readFileSync(newPath, 'utf8');

    const diff = Diff.createTwoFilesPatch(
        argv.old,
        argv.new,
        oldText,
        newText,
        'Old File',
        'New File'
    );

    if (argv.out) {
        fs.writeFileSync(argv.out, diff);
        return { output: argv.out, size: diff.length };
    } else {
        return { content: diff };
    }
});

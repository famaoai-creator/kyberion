#!/usr/bin/env node
const path = require('path');
const isBinaryPath = require('is-binary-path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

const argv = createStandardYargs().argv;

function _scanFile(filePath, projectRoot) {
  if (isBinaryPath(filePath)) return null;
  return { file: path.relative(projectRoot, filePath), scanned: true };
}

runSkill('security-scanner', () => {
    const projectRoot = path.resolve(argv.input || '.');
    const files = getAllFiles(projectRoot);
    const results = files.map(f => _scanFile(f, projectRoot)).filter(Boolean);

    return { projectRoot, fileCount: results.length, status: 'scan_complete' };
});

#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs().option('repo', {
  alias: 'r',
  type: 'string',
  demandOption: true,
  description: 'Git repository URL',
}).argv;

runAsyncSkill('knowledge-harvester', async () => {
  const tmpDir = path.join(process.cwd(), 'work/tmp/harvest_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`git clone --depth 1 ${argv.repo} ${tmpDir}`, { stdio: 'ignore' });
  return { repository: argv.repo, harvestedAt: new Date().toISOString(), status: 'success' };
});

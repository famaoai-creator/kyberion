#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');

const argv = createStandardYargs().option('repo', {
  alias: 'r',
  type: 'string',
  demandOption: true,
  description: 'Git repository URL',
}).argv;

runAsyncSkill('knowledge-harvester', async () => {
  const tmpDir = path.join(pathResolver.shared('tmp'), 'harvest_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`git clone --depth 1 ${argv.repo} ${tmpDir}`, { stdio: 'ignore' });
  const result = {
    repository: argv.repo,
    harvestedAt: new Date().toISOString(),
    status: 'success',
  };

  // Phase 3: Auto-Wiki (Local Sync)
  const rootDir = path.resolve(__dirname, '../..');
  const indexFile = path.join(rootDir, 'knowledge/_index.md');
  const skills = fs
    .readdirSync(rootDir)
    .filter((f) => fs.existsSync(path.join(rootDir, f, 'SKILL.md')));

  let md = '# Ecosystem Knowledge Base\n\n## Available Skills\n\n';
  skills.sort().forEach((s) => {
    md += `- **${s}**: [Documentation](../${s}/SKILL.md)\n`;
  });
  fs.writeFileSync(indexFile, md);

  result.local_sync = { updated: 'knowledge/_index.md', skills_indexed: skills.length };
  return result;
});

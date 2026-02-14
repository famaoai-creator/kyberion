#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');

const argv = createStandardYargs()
  .option('repo', { alias: 'r', type: 'string', description: 'Repository URL', demandOption: true })
  .option('name', { alias: 'n', type: 'string', description: 'Local name' })
  .argv;

runAsyncSkill('source-importer', async () => {
  const repoUrl = argv.repo;
  const repoName = argv.name || path.basename(repoUrl, '.git');
  const quarantineDir = path.join(pathResolver.activeRoot(), 'quarantine', repoName);
  const registryPath = pathResolver.shared('registry/source_registry.json');

  console.log(chalk.cyan(`\n\u23f3 Importing: ${repoName}...`));

  // 1. Secure Clone
  if (fs.existsSync(quarantineDir)) {
    console.log(chalk.yellow(`  [!] Source "${repoName}" already exists in quarantine. Updating...`));
    execSync(`git pull`, { cwd: quarantineDir, stdio: 'ignore' });
  } else {
    fs.mkdirSync(path.dirname(quarantineDir), { recursive: true });
    execSync(`git clone --depth 1 ${repoUrl} ${quarantineDir}`, { stdio: 'ignore' });
  }

  // 2. Mandatory Gating (Security & Sensitivity)
  console.log(chalk.yellow(`\n\ud83d\udee1  Mandatory Security Scan in progress...`));
  let scanResult = "Not scanned";
  try {
    const scanOutput = execSync(`node scripts/cli.cjs run security-scanner --dir ${quarantineDir}`, { encoding: 'utf8' });
    scanResult = scanOutput.includes('findingCount: 0') ? 'Passed' : 'Warning: Issues Found';
    console.log(chalk.green(`  Scan Status: ${scanResult}`));
  } catch (e) {
    console.error(chalk.red(`  [!] Security scan failed to execute.`));
  }

  // 3. Provenance Registry
  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : { sources: [] };
  const entry = {
    id: repoName,
    url: repoUrl,
    importedAt: new Date().toISOString(),
    status: scanResult === 'Passed' ? 'verified' : 'quarantined',
    scanResult,
    localPath: quarantineDir
  };

  const existingIdx = registry.sources.findIndex(s => s.id === repoName);
  if (existingIdx !== -1) registry.sources[existingIdx] = entry;
  else registry.sources.push(entry);

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  console.log(chalk.bold.green(`\n\u2714 Source "${repoName}" registered in Quarantine Registry.`));

  return entry;
});

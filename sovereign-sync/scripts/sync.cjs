#!/usr/bin/env node

/**
 * sovereign-sync/scripts/sync.cjs
 * Manages external Git operations for specific Knowledge tiers.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const action = args[0]; // init, pull, push
const tier = args[1] || 'confidential';
const remoteUrl = args[2];

const tierPath = path.join(process.cwd(), 'knowledge', tier);

function runGit(cmd, cwd) {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf8' });
  } catch (_e) {
    console.error(`Git error in ${cwd}:`, e.message);
    process.exit(1);
  }
}

if (action === 'init') {
  if (!remoteUrl) {
    console.error('Usage: node sync.cjs init <tier> <remote_url>');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(tierPath, '.git'))) {
    console.log(`Initializing ${tier} as a separate Git repo...`);
    runGit('init', tierPath);
    runGit(`remote add origin ${remoteUrl}`, tierPath);
    console.log(`Linked to: ${remoteUrl}`);
  }
} else if (action === 'pull') {
  console.log(`Importing updates for ${tier} tier...`);
  runGit('pull origin develop', tierPath);
  console.log('Success: Imported latest knowledge.');
} else if (action === 'push') {
  console.log(`Sharing local updates for ${tier} tier...`);
  runGit('add .', tierPath);
  runGit('commit -m "docs: Automated knowledge update via sovereign-sync"', tierPath);
  runGit('push origin develop', tierPath);
  console.log('Success: Shared updates with organization.');
} else {
  console.error('Available actions: init, pull, push');
}

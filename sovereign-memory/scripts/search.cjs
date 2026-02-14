#!/usr/bin/env node

/**
 * sovereign-memory/scripts/search.cjs
 * Searches across all Matrix tiers (personal, roles, confidential, public).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const query = process.argv.slice(2).join(' ');

if (!query) {
  console.error('Usage: node search.cjs <query>');
  process.exit(1);
}

const tiers = [
  { name: 'personal', path: path.join(process.cwd(), 'knowledge', 'personal', 'memories') },
  { name: 'roles/ceo', path: path.join(process.cwd(), 'knowledge', 'roles', 'ceo', 'memories') },
  { name: 'confidential', path: path.join(process.cwd(), 'knowledge', 'confidential', 'memories') },
  { name: 'public', path: path.join(process.cwd(), 'knowledge', 'public', 'memories') },
];

console.log(`--- Searching for "${query}" across the Sovereign Matrix ---`);

tiers.forEach((tier) => {
  if (fs.existsSync(tier.path)) {
    try {
      const result = execSync(`grep -rEi "${query}" "${tier.path}"`, { encoding: 'utf8' });
      console.log(`\n[${tier.name.toUpperCase()} Tier]`);
      console.log(result);
    } catch (_error) {
      // Not found
    }
  }
});

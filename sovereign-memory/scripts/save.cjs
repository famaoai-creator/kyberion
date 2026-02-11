#!/usr/bin/env node

/**
 * sovereign-memory/scripts/save.cjs
 * Saves a fact to a specific category, tier, and sub-domain.
 * Supports: personal, roles, confidential, public.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

if (args.length < 3) {
  console.error('Usage: node save.cjs <tier> <category> <fact_description> [subdomain]');
  console.error('Tiers: personal, roles, confidential, public');
  process.exit(1);
}

const tier = args[0].toLowerCase();
const category = args[1].toLowerCase();
const fact = args.slice(2).join(' ');

// Validate tier
const allowedTiers = ['personal', 'roles', 'confidential', 'public'];
if (!allowedTiers.includes(tier)) {
  console.error(`Invalid tier: ${tier}. Allowed: ${allowedTiers.join(', ')}`);
  process.exit(1);
}

// Special handling for Roles (requires role name)
let memoryRoot;
if (tier === 'roles') {
  memoryRoot = path.join(process.cwd(), 'knowledge', 'roles', 'ceo', 'memories'); // Default to CEO for now
} else {
  memoryRoot = path.join(process.cwd(), 'knowledge', tier, 'memories');
}

const filePath = path.join(memoryRoot, `${category}.md`);

if (!fs.existsSync(memoryRoot)) {
  fs.mkdirSync(memoryRoot, { recursive: true });
}

const timestamp = new Date().toISOString().split('T')[0];
const entry = `- [${timestamp}] ${fact}\n`;

try {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# ${category.toUpperCase()} Memories (${tier.toUpperCase()})\n\n${entry}`);
  } else {
    fs.appendFileSync(filePath, entry);
  }
  console.log(`Success: Memorized in ${tier} tier: "${fact}"`);
} catch (error) {
  console.error('Error saving memory:', error.message);
  process.exit(1);
}

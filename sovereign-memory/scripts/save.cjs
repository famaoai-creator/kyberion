#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');

/**
 * sovereign-memory/scripts/save.cjs
 * Standardized Sovereign Memory Saver
 */

const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { requireArgs } = require('../../scripts/lib/validators.cjs');
const fs = require('fs');
const path = require('path');

runSkill('sovereign-memory', () => {
  const args = requireArgs(['tier', 'category', 'fact']);

  const tier = args.tier.toLowerCase();
  const category = args.category.toLowerCase();
  const fact = args.fact;

  const allowedTiers = ['personal', 'roles', 'confidential', 'public'];
  if (!allowedTiers.includes(tier)) {
    throw new Error(`Invalid tier: ${tier}. Allowed: ${allowedTiers.join(', ')}`);
  }

  let memoryRoot;
  if (tier === 'roles') {
    memoryRoot = path.join(process.cwd(), 'knowledge', 'roles', 'ceo', 'memories');
  } else {
    memoryRoot = path.join(process.cwd(), 'knowledge', tier, 'memories');
  }

  const filePath = path.join(memoryRoot, `${category}.md`);

  if (!fs.existsSync(memoryRoot)) {
    fs.mkdirSync(memoryRoot, { recursive: true });
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const entry = `- [${timestamp}] ${fact}\n`;

  if (!fs.existsSync(filePath)) {
    safeWriteFile(
      filePath,
      `# ${category.toUpperCase()} Memories (${tier.toUpperCase()})\n\n${entry}`
    );
  } else {
    require('../../scripts/lib/secure-io.cjs').safeAppendFileSync(filePath, entry);
  }

  return {
    status: 'memorized',
    tier,
    category,
    path: filePath,
  };
});

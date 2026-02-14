#!/usr/bin/env node
/**
 * connection-manager/scripts/diagnose.cjs
 * Standardized Connectivity Diagnostic
 */

const { runSkill } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');
const fs = require('fs');
const path = require('path');

runSkill('connection-manager', () => {
  const args = requireArgs(['system']);
  const system = args.system.toLowerCase();

  // 1. Check Inventory
  const inventoryPath = path.resolve(
    __dirname,
    '../../knowledge/confidential/connections/inventory.json'
  );
  if (!fs.existsSync(inventoryPath)) {
    throw new Error(`Inventory not found at ${inventoryPath}`);
  }

  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const config = inventory.systems[system];

  if (!config) {
    throw new Error(`System '${system}' not defined in inventory.`);
  }

  // 2. Check Personal Credentials
  const secretPath = path.resolve(__dirname, '../../', config.credential_ref);
  const hasSecret = fs.existsSync(secretPath);

  return {
    system,
    config_status: 'valid',
    credential_status: hasSecret ? 'found' : 'missing',
    credential_path: config.credential_ref,
    ready: hasSecret,
  };
});

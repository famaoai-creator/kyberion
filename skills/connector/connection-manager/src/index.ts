import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import * as pathResolver from '@agent/core/path-resolver';
import { diagnoseConnection } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('connection-manager', () => {
    const args = requireArgs(['system']);
    const rootDir = pathResolver.rootDir();

    const inventoryPath = path.join(rootDir, 'knowledge/confidential/connections/inventory.json');
    if (!fs.existsSync(inventoryPath)) {
      throw new Error('Inventory not found');
    }

    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    return diagnoseConnection(args.system as string, inventory, rootDir);
  });
}

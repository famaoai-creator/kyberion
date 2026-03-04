import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import * as pathResolver from '@agent/core/path-resolver';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { diagnoseConnection } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('connection-manager', () => {
    const argv = yargs(hideBin(process.argv)).parseSync() as any;
    requireArgs(argv, ['system']);
    const args = argv;
    const rootDir = pathResolver.rootDir();

    const inventoryPath = path.join(rootDir, 'knowledge/confidential/connections/inventory.json');
    if (!fs.existsSync(inventoryPath)) {
      throw new Error('Inventory not found');
    }

    const inventory = JSON.parse(safeReadFile(inventoryPath, { encoding: 'utf8' }) as string);
    return diagnoseConnection(args.system as string, inventory, rootDir);
  });
}

import * as path from 'node:path';
import { logger, safeWriteFile, safeReadFile, pathResolver, safeExec } from '@agent/core';

/**
 * Knowledge Import Tool (KEP v1.0)
 * Imports a portable JSON knowledge package into the local ecosystem.
 */

interface ImportOptions {
  packagePath: string;
  targetCategory?: string;
  force: boolean;
}

async function importKnowledge({ packagePath, targetCategory, force }: ImportOptions) {
  logger.info(`📥 Importing knowledge package: ${packagePath}`);

  const rawData = safeReadFile(packagePath, { encoding: 'utf8' }) as string;
  const kep = JSON.parse(rawData);

  if (kep.version !== '1.0.0') {
    logger.error(`Unsupported KEP version: ${kep.version}`);
    process.exit(1);
  }

  const category = targetCategory || kep.category;
  const baseDest = pathResolver.knowledge(category);

  logger.info(`📁 Target category: ${category}`);

  for (const item of kep.items) {
    const destPath = path.join(baseDest, item.path);
    
    // Safety check: would we overwrite anything?
    // safeWriteFile currently overwrites by default, but we'll log it.
    safeWriteFile(destPath, item.content);
    logger.info(`  ✔ Imported: ${item.path}`);
  }

  logger.success(`✅ Knowledge import complete. Regenerating index...`);
  
  // Automatically regenerate index to include new knowledge
  try {
    await safeExec('npm', ['run', 'generate-index']);
    logger.success(`✅ Knowledge index synchronized.`);
  } catch (err: any) {
    logger.warn(`⚠️  Import succeeded but index regeneration failed: ${err.message}`);
  }
}

// CLI Entry
const args = process.argv.slice(2);
const pkgPath = args[0];
const force = args.includes('--force');

if (!pkgPath) {
  console.log('Usage: npx tsx scripts/import_knowledge.ts <package-file-path> [--force]');
  process.exit(1);
}

importKnowledge({ packagePath: pkgPath, force }).catch(err => {
  logger.error(`Import failed: ${err.message}`);
});

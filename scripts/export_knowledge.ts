import * as path from 'node:path';
import { logger, safeWriteFile, safeReadFile, pathResolver, getAllFiles } from '@agent/core';

/**
 * Knowledge Export Tool (KEP v1.0)
 * Exports a knowledge directory or specific files into a portable JSON package.
 */

interface ExportOptions {
  category: string;
  outputFile?: string;
}

async function exportKnowledge({ category, outputFile }: ExportOptions) {
  const knowledgePath = pathResolver.knowledge(category);
  
  const files = getAllFiles(knowledgePath).filter(f => f.endsWith('.md'));

  if (files.length === 0) {
    logger.error(`No knowledge files found in category: ${category}`);
    process.exit(1);
  }

  logger.info(`📦 Exporting knowledge category: ${category} (${files.length} files)`);

  const kep: any = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    category,
    items: []
  };

  for (const file of files) {
    const relPath = path.relative(knowledgePath, file);
    const content = safeReadFile(file, { encoding: 'utf8' }) as string;
    
    kep.items.push({
      path: relPath,
      content: content
    });
  }

  const resultJson = JSON.stringify(kep, null, 2);
  const outFileName = `kep_${category.replace(/\//g, '_')}_${Date.now()}.json`;
  const outPath = outputFile || path.join(pathResolver.rootDir(), 'hub/exports', outFileName);
  
  safeWriteFile(outPath, resultJson);
  
  logger.success(`✅ Knowledge exported successfully to: ${outPath}`);
}

// CLI Entry
const args = process.argv.slice(2);
const category = args[0];

if (!category) {
  console.log('Usage: npx tsx scripts/export_knowledge.ts <category-path>');
  console.log('Example: npx tsx scripts/export_knowledge.ts governance');
  process.exit(1);
}

exportKnowledge({ category }).catch(err => {
  logger.error(`Export failed: ${err.message}`);
});

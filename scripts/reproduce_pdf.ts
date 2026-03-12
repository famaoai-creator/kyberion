import { distillPdfDesign, logger, pathResolver } from '@agent/core';
import { generateNativePdf } from '@agent/core/src/native-pdf-engine/engine.js';
import * as path from 'node:path';

async function main() {
  const source = pathResolver.rootResolve('vault/PDF20_AN001-BPC.pdf');
  const output = pathResolver.rootResolve('hoge.pdf');

  logger.info(`🔍 Ingesting PDF design from: ${source}...`);
  
  // 1. Ingest existing design (including aesthetics/coordinates)
  const design = await distillPdfDesign(source, { aesthetic: true });

  // 2. Modify Title as requested
  if (design.metadata) {
    const oldTitle = design.metadata.title || 'Untitled Spec';
    design.metadata.title = `Kyberion ${oldTitle}`;
    logger.info(`✨ Title updated: ${design.metadata.title}`);
  }

  logger.info('🚀 Regenerating PDF using Native PDF 2.0 Engine...');

  // 3. Generate new PDF from the modified ADF
  await generateNativePdf(design, output);

  logger.success(`✅ Successfully created: ${output}`);
}

main().catch(err => {
  logger.error(`Failed to reproduce PDF: ${err.message}`);
  process.exit(1);
});

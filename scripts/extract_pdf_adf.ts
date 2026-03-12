import { distillPdfDesign, logger, pathResolver, safeWriteFile } from '@agent/core';
import * as path from 'node:path';

async function main() {
  const source = pathResolver.rootResolve('vault/PDF20_AN001-BPC.pdf');
  const outputJson = pathResolver.rootResolve('extracted_design.json');

  logger.info(`🔍 Extracting full ADF (Design + Text) from: ${source}...`);
  
  // Natively distill the PDF into its structured ADF representation
  const design = await distillPdfDesign(source, { aesthetic: true });

  // Save the complete ADF to a JSON file
  safeWriteFile(outputJson, JSON.stringify(design, null, 2));

  logger.success(`✅ ADF extracted and saved to: ${outputJson}`);
  
  // Preview summary
  console.log('\n--- Extraction Summary ---');
  console.log('Protocol Version:', design.version);
  console.log('Title:', design.metadata?.title);
  console.log('Page Count:', design.metadata?.pageCount);
  console.log('Text Sample (first 200 chars):', design.content?.text.substring(0, 200));
  console.log('---------------------------\n');
}

main().catch(err => {
  logger.error(`Extraction failed: ${err.message}`);
  process.exit(1);
});

/**
 * DOCX Round-Trip Demo
 * 1. Extract DocxDesignProtocol from an existing .docx
 * 2. Re-generate a new .docx from the extracted protocol
 * 3. Print comparison summary
 */
import * as path from 'path';
import * as fs from 'fs';
import { distillDocxDesign } from '../../docx-utils.js';
import { generateNativeDocx } from '../engine.js';

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: npx tsx roundtrip_docx.ts <input.docx>');
    process.exit(1);
  }

  const absSource = path.resolve(sourcePath);
  console.log(`📄 Source: ${absSource}`);
  console.log(`   Size: ${fs.statSync(absSource).size} bytes\n`);

  // Step 1: Extract
  console.log('Step 1: Extracting DocxDesignProtocol...');
  const protocol = await distillDocxDesign(absSource);

  console.log(`  - Version: ${protocol.version}`);
  console.log(`  - Body blocks: ${protocol.body.length}`);
  console.log(`  - Sections: ${protocol.sections.length}`);
  console.log(`  - Styles: ${protocol.styles.definitions.length}`);
  console.log(`  - Headers/Footers: ${protocol.headersFooters.length}`);
  console.log(`  - Relationships: ${protocol.relationships.length}`);
  if (protocol.numbering) {
    console.log(`  - AbstractNums: ${protocol.numbering.abstractNums.length}`);
    console.log(`  - Nums: ${protocol.numbering.nums.length}`);
  }

  // Count block types
  const blockTypes: Record<string, number> = {};
  for (const block of protocol.body) {
    blockTypes[block.type] = (blockTypes[block.type] || 0) + 1;
  }
  console.log(`  - Block types: ${JSON.stringify(blockTypes)}`);

  // Step 2: Re-generate
  const outDir = path.dirname(absSource);
  const baseName = path.basename(absSource, '.docx');
  const outputPath = path.join(outDir, `${baseName}_regenerated.docx`);
  console.log(`\nStep 2: Generating ${outputPath}...`);
  await generateNativeDocx(protocol, outputPath);

  const outSize = fs.statSync(outputPath).size;
  console.log(`  - Output size: ${outSize} bytes`);

  // Step 3: Re-extract and compare
  console.log('\nStep 3: Re-extracting for comparison...');
  const reExtracted = await distillDocxDesign(outputPath);

  console.log(`  - Body blocks: ${protocol.body.length} → ${reExtracted.body.length}`);
  console.log(`  - Styles: ${protocol.styles.definitions.length} → ${reExtracted.styles.definitions.length}`);
  console.log(`  - Sections: ${protocol.sections.length} → ${reExtracted.sections.length}`);
  console.log(`  - Relationships: ${protocol.relationships.length} → ${reExtracted.relationships.length}`);

  // Count text
  function countText(body: typeof protocol.body): number {
    let count = 0;
    for (const block of body) {
      if (block.type === 'paragraph') {
        for (const pc of block.paragraph.content) {
          if (pc.type === 'run') {
            for (const c of pc.run.content) {
              if (c.type === 'text') count += c.text.length;
            }
          }
        }
      }
    }
    return count;
  }

  const origChars = countText(protocol.body);
  const regenChars = countText(reExtracted.body);
  console.log(`  - Text chars: ${origChars} → ${regenChars}`);

  console.log('\n✅ Round-trip complete!');
  console.log(`   ${outputPath}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

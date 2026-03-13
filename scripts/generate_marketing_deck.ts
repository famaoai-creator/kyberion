import { pathResolver, logger, safeMkdir } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { generatePptxWithDesign } from '../libs/core/src/pptx-utils.js';
import { PptxDesignProtocol } from '../libs/core/src/types/pptx-protocol.js';

async function main() {
  const patternPath = pathResolver.knowledge('public/design-patterns/presentation/kyberion-marketing-deck.json');
  const outputPath = path.join(process.cwd(), 'scratch/Kyberion_Marketing_Deck.pptx');
  
  logger.info('🚀 Generating Kyberion Marketing Deck (20 slides)...');
  
  if (!fs.existsSync(path.dirname(outputPath))) {
    safeMkdir(path.dirname(outputPath), { recursive: true });
  }

  const pattern = JSON.parse(fs.readFileSync(patternPath, 'utf8'));
  
  // Construct the Full Design Protocol
  const protocol: PptxDesignProtocol = {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas: { w: 10, h: 5.625 }, // 16:9
    theme: {
      "dk1": "000000",
      "lt1": "FFFFFF",
      "accent1": "38BDF8" // Kyberion Blue
    },
    master: {
      elements: []
    },
    slides: pattern.content_data.map((data: any, idx: number) => ({
      id: `slide${idx + 1}`,
      elements: [
        // Title
        {
          type: 'text',
          placeholderType: 'title',
          pos: { x: 0.5, y: 0.5, w: 9, h: 1 },
          text: data.title,
          style: { fontSize: 32, bold: true, color: '000000', align: 'center' }
        },
        // Body / Subtitle
        {
          type: 'text',
          placeholderType: 'body',
          pos: { x: 1, y: 1.5, w: 8, h: 3 },
          text: (data.body || []).join('\n') || data.subtitle || '',
          style: { fontSize: 18, color: '334155', align: 'left', valign: 'top' }
        },
        // Visual Placeholder
        {
          type: 'shape',
          shapeType: 'rect',
          pos: { x: 1, y: 4.5, w: 8, h: 0.5 },
          text: `[Visual: ${data.visual}]`,
          style: { fill: 'F1F5F9', color: '64748B', fontSize: 12, italic: true, align: 'center', valign: 'middle' }
        }
      ]
    }))
  };

  try {
    await generatePptxWithDesign(protocol, outputPath);
    logger.success(`✅ Presentation generated successfully at: ${outputPath}`);
  } catch (err: any) {
    logger.error(`Failed to generate PPTX: ${err.message}`);
    process.exit(1);
  }
}

main();

import '@agent/core/secure-io';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAsyncSkill } from '@agent/core';
import { validateFilePath } from '@agent/core/validators';
import { distillPptxDesign, generatePptxWithDesign } from '@agent/core/pptx-utils';
import { convertToPPTX } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    description: 'Path to input Markdown or JSON data file',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    demandOption: true,
    description: 'Output PPTX or JSON file path',
  })
  .option('distill', {
    alias: 'd',
    type: 'string',
    description: 'Path to source PPTX to extract Design Protocol (ADF)',
  })
  .option('template', {
    alias: 't',
    type: 'string',
    description: 'Path to Design Protocol JSON (ADF) to apply as a template',
  })
  .option('assets', {
    type: 'string',
    description: 'Path to directory for media assets',
  })
  .parseSync();

runAsyncSkill('ppt-artisan', async () => {
  const outputPath = path.resolve(argv.out as string);
  const assetsDir = argv.assets ? path.resolve(argv.assets as string) : path.join(path.dirname(outputPath), 'assets');

  // Mode: Distill (Extract Design)
  if (argv.distill) {
    const sourcePath = path.resolve(argv.distill as string);
    validateFilePath(sourcePath, 'source pptx');
    console.log(`[PptArtisan] Distilling design from: ${sourcePath}`);
    const protocol = await distillPptxDesign(sourcePath, assetsDir);
    fs.writeFileSync(outputPath, JSON.stringify(protocol, null, 2));
    console.log(`[PptArtisan] Design Protocol (ADF) saved to: ${outputPath}`);
    return { output: outputPath, assets: assetsDir };
  }

  // Mode: Generate with ADF Template
  if (argv.template) {
    const templatePath = path.resolve(argv.template as string);
    validateFilePath(templatePath, 'template file');
    console.log(`[PptArtisan] Generating PPTX using template: ${templatePath}`);
    
    const protocol = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const pptx = await generatePptxWithDesign(protocol, assetsDir);
    
    await pptx.writeFile({ fileName: outputPath });
    console.log(`[PptArtisan] Replicated PPTX created at: ${outputPath}`);
    return { output: outputPath };
  }

  // Mode: Legacy Markdown/Marp Generation
  if (argv.input) {
    const inputPath = validateFilePath(argv.input as string, 'input file');
    const ext = path.extname(inputPath).toLowerCase();

    if (ext === '.md') {
      const markdownContent = fs.readFileSync(inputPath, 'utf8');
      const markdownArtifact = {
        title: path.basename(inputPath, '.md'),
        body: markdownContent,
        format: 'markdown' as const,
      };

      const result = await convertToPPTX({
        markdown: markdownArtifact,
        outputPath,
      });
      return result;
    }
  }

  console.error('[PptArtisan] Invalid usage. Provide either --distill, --template, or --input <markdown>.');
  process.exit(1);
});

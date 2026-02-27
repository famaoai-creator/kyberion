import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { generateMarpCSS, MasterSlideSpecs } from './lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    description: 'Path to master-slide-specs.json',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output CSS file path',
  })
  .parseSync();

runSkill('layout-architect', () => {
  // Default specs path relative to project structure
  const defaultSpecsPath = path.resolve(
    __dirname,
    '../../../knowledge/standards/design/master-slide-specs.json'
  );
  const specsPath = argv.input ? path.resolve(argv.input as string) : defaultSpecsPath;

  if (!fs.existsSync(specsPath)) {
    throw new Error(`Master specs not found at: ${specsPath}`);
  }

  const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8')) as MasterSlideSpecs;
  const css = generateMarpCSS(specs);

  // Default output path if not specified
  const defaultOutPath = path.resolve(
    __dirname,
    `../../../knowledge/templates/themes/${specs.master_name.toLowerCase()}.css`
  );
  const outPath = argv.out ? path.resolve(argv.out as string) : defaultOutPath;

  safeWriteFile(outPath, css);

  return {
    status: 'theme_generated',
    masterName: specs.master_name,
    output: outPath,
  };
});

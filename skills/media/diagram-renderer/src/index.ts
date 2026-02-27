import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { adfToMermaid, ADF, IconMap } from './lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to input ADF JSON file',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    demandOption: true,
    description: 'Output image file path (PNG/SVG)',
  })
  .parseSync();

runSkill('diagram-renderer', () => {
  const inputPath = path.resolve(argv.input as string);
  const outputPath = path.resolve(argv.out as string);
  const mmdPath = outputPath.replace(/\.[^.]+$/, '.mmd');

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const adf = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as ADF;

  // Icon map path relative to this skill's source/dist
  // Knowledge is at knowledge/skills/diagram-renderer/icon-map.json
  const iconMapPath = path.resolve(
    __dirname,
    '../../../knowledge/skills/diagram-renderer/icon-map.json'
  );
  if (!fs.existsSync(iconMapPath)) {
    throw new Error(`Icon map knowledge missing: ${iconMapPath}`);
  }
  const iconMap = JSON.parse(fs.readFileSync(iconMapPath, 'utf8')) as IconMap;

  const mmdContent = adfToMermaid(adf, iconMap);
  safeWriteFile(mmdPath, mmdContent);

  try {
    // Ensure mermaid-cli is called from the project root or via npx
    execSync(`npx -y @mermaid-js/mermaid-cli -i "${mmdPath}" -o "${outputPath}"`, {
      stdio: 'inherit',
    });
  } catch (err: any) {
    throw new Error(`Rendering failed: ${err.message}`);
  }

  return { status: 'success', intermediateArtifact: mmdPath, finalArtifact: outputPath };
});

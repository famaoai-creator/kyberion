import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { parseTerraformContent } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Directory with Terraform files',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for infrastructure map',
  })
  .help()
  .parseSync();

runSkill('terraform-arch-mapper', () => {
  const tfDir = path.resolve(argv.input as string);
  if (!fs.existsSync(tfDir)) {
    throw new Error(`Directory not found: ${tfDir}`);
  }

  const files = fs.readdirSync(tfDir).filter((f) => f.endsWith('.tf'));

  let allNodes: any[] = [];
  let allEdges: any[] = [];

  files.forEach((file) => {
    const { nodes, edges } = parseTerraformContent(fs.readFileSync(path.join(tfDir, file), 'utf8'));
    allNodes = allNodes.concat(nodes);
    allEdges = allEdges.concat(edges);
  });

  const adf = { nodes: allNodes, edges: allEdges };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(adf, null, 2));
  }

  return { status: 'success', adf };
});

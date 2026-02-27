import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAsyncSkill } from '@agent/core';
import { writeArtifact } from '@agent/core/secure-io';
import { validateFilePath } from '@agent/core/validators';
import { extractTextFromFile, extractDesignMetadata, createDocumentArtifact } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to input document file',
  })
  .parseSync();

runAsyncSkill('doc-to-text', async () => {
  const inputPath = validateFilePath(argv.input as string, 'input file');
  const text = await extractTextFromFile(inputPath);
  const design = extractDesignMetadata(inputPath);

  // Define logical artifact location
  const artifactDir = path.resolve('active/missions/mission-pptx-remaster/artifacts');
  if (!fs.existsSync(artifactDir)) fs.mkdirSync(artifactDir, { recursive: true });

  const artifactPath = path.join(artifactDir, path.basename(inputPath) + '.md');

  // Use HAP (Hashed Artifact Pointer) protocol
  const pointer = (writeArtifact as any)(artifactPath, text, 'markdown');

  const result = createDocumentArtifact(
    path.basename(inputPath),
    'Full content stored in hashed artifact.',
    design
  );
  result.pointer = pointer;

  return result;
});

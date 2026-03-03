import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { requireArgs } from '@agent/core/validators';
import { classifyDocType, Category } from './lib.js';
import pathResolver from '@agent/core/path-resolver';

runSkill('doc-type-classifier', () => {
  const argv = requireArgs(['input']);
  const inputPath = path.resolve(argv.input as string);
  const rulesPath = path.join(
    pathResolver.rootDir(),
    'knowledge/skills/doc-type-classifier/rules.json'
  );

  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: \${inputPath}`);
  const rules = JSON.parse(safeReadFile(rulesPath, { encoding: 'utf8' }) as string);
  const content = safeReadFile(inputPath, { encoding: 'utf8' }) as string;

  const result = classifyDocType(content, rules.categories as Category[]);

  return {
    file: path.basename(inputPath),
    scap_layer: result,
    confidence: result === 'Unknown' ? 'low' : 'high',
  };
});

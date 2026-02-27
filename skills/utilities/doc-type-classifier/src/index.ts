import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import { classifyDocType, Category } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('doc-type-classifier', () => {
    const argv = requireArgs(['input']);
    const inputPath = path.resolve(argv.input as string);
    const rulesPath = path.resolve(
      __dirname,
      '../../../knowledge/skills/doc-type-classifier/rules.json'
    );

    if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const content = fs.readFileSync(inputPath, 'utf8');

    const result = classifyDocType(content, rules.categories as Category[]);

    return {
      file: path.basename(inputPath),
      scap_layer: result,
      confidence: result === 'Unknown' ? 'low' : 'high',
    };
  });
}

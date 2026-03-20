import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';
import { parseFrontmatter } from '../scripts/context_ranker.js';

const rootDir = process.cwd();
const schemaPath = path.join(rootDir, 'knowledge/public/schemas/knowledge-card.schema.json');
const schema = JSON.parse(safeReadFile(schemaPath, { encoding: 'utf8' }) as string);
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

const representativeDocs = [
  'knowledge/public/architecture/channel-port-surface-model.md',
  'knowledge/public/standards/aws_fisc_standard.md',
  'knowledge/public/roles/solution_architect/PROCEDURE.md',
  'knowledge/public/architecture/knowledge-card-overlay-model.md',
  'knowledge/public/governance/knowledge-protocol.md',
  'knowledge/public/orchestration/onboarding-protocol.md',
  'knowledge/public/procedures/browser/navigate-web.md',
  'knowledge/public/standards/ipa/requirements-checklist.md',
  'knowledge/public/roles/knowledge_steward/PROCEDURE.md',
];

describe('Knowledge card contract', () => {
  it('validates representative card metadata against the knowledge card schema', () => {
    for (const relPath of representativeDocs) {
      const content = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
      const frontmatter = parseFrontmatter(content);
      const valid = validate(frontmatter);
      expect(valid, `${relPath}\n${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });
});

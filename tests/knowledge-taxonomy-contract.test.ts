import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

describe('Knowledge taxonomy contract', () => {
  it('validates the knowledge taxonomy manifest against its schema', () => {
    const schema = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/schemas/knowledge-taxonomy.schema.json'), { encoding: 'utf8' }) as string,
    );
    const taxonomy = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/governance/knowledge-taxonomy.json'), { encoding: 'utf8' }) as string,
    );
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(taxonomy);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('covers the primary public knowledge categories with taxonomy defaults', () => {
    const taxonomy = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/governance/knowledge-taxonomy.json'), { encoding: 'utf8' }) as string,
    ) as {
      directory_defaults: Array<{ path_prefix: string; kind: string }>;
    };

    const coveredPrefixes = new Set(taxonomy.directory_defaults.map(entry => entry.path_prefix));
    expect(coveredPrefixes.has('knowledge/public/governance/')).toBe(true);
    expect(coveredPrefixes.has('knowledge/public/standards/')).toBe(true);
    expect(coveredPrefixes.has('knowledge/public/architecture/')).toBe(true);
    expect(coveredPrefixes.has('knowledge/public/procedures/')).toBe(true);
    expect(coveredPrefixes.has('knowledge/public/roles/')).toBe(true);
    expect(coveredPrefixes.has('knowledge/public/capability-assets/')).toBe(true);
    expect(coveredPrefixes.has('knowledge/public/incidents/')).toBe(true);
  });

  it('does not leave legacy skill vocabulary in the active taxonomy and governance path', () => {
    let output = '';
    try {
      output = execSync(
        'rg -n "skill-bundle-packager|global_skill_index|restricted-skills|skill entry points|Maps abstract user intents to concrete skill chains" knowledge/public docs/COMPONENT_MAP.md docs/GLOSSARY.md',
        { cwd: rootDir, encoding: 'utf8' },
      ).trim();
    } catch (error) {
      output = ((error as { stdout?: string }).stdout || '').trim();
    }

    expect(output).toBe('');
  });
});

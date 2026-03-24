import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';

const rootDir = process.cwd();

function loadJson(filePath: string) {
  return JSON.parse(safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string);
}

describe('Computer interaction contract schema', () => {
  it('accepts a governed snapshot request', () => {
    const ajv = new Ajv({ allErrors: true });
    const schema = loadJson('schemas/computer-interaction.schema.json');
    const validate = ajv.compile(schema);

    const payload = {
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'browser-session-1',
      target: {
        surface_id: 'computer-surface',
        runtime_id: 'browser-runtime-1',
        tab_id: 'tab-1',
        domain: 'app.example.com'
      },
      observation: {
        mode: 'mixed',
        include_screenshot: true,
        include_refs: true,
        include_console: true,
        viewport: {
          width: 1024,
          height: 768,
          scale: 1
        }
      },
      action: {
        type: 'snapshot',
        timeout_ms: 1500
      },
      risk: {
        level: 'low',
        requires_approval: false,
        approval_scope: 'none'
      }
    };

    const valid = validate(payload);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('accepts a risky publish-style click proposal', () => {
    const ajv = new Ajv({ allErrors: true });
    const schema = loadJson('schemas/computer-interaction.schema.json');
    const validate = ajv.compile(schema);

    const payload = {
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'browser-session-2',
      action: {
        type: 'click_ref',
        ref: '@publishButton'
      },
      risk: {
        level: 'high',
        reason: 'publishes content to an external service',
        requires_approval: true,
        approval_scope: 'workflow'
      }
    };

    const valid = validate(payload);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('rejects payloads without action', () => {
    const ajv = new Ajv({ allErrors: true });
    const schema = loadJson('schemas/computer-interaction.schema.json');
    const validate = ajv.compile(schema);

    const payload = {
      version: '0.1',
      kind: 'computer_interaction',
      session_id: 'browser-session-3'
    };

    const valid = validate(payload);
    expect(valid).toBe(false);
  });
});

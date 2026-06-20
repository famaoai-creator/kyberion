import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { compileSchemaFromPath } from '../libs/core/schema-loader.js';
import { adaptInboundInquiryToWorkflow } from '../libs/core/inbound-inquiry-adapter.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

function readJson(relativePath: string): unknown {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string,
  ) as unknown;
}

describe('inbound inquiry contract', () => {
  it('validates the canonical example and renders deterministic workflow text', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = pathResolver.rootResolve('schemas/inbound-inquiry.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const example = readJson('knowledge/product/schemas/inbound-inquiry.example.json');

    expect(validate(example), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(
      adaptInboundInquiryToWorkflow(example as {
        source: string;
        received_at: string;
        lead: { name: string; org: string; email: string };
        message: string;
        metadata?: Record<string, unknown>;
      }),
    ).toBe(
      [
        '# Inbound Inquiry',
        '',
        'Source: web_form',
        'Received at: 2026-06-21T09:00:00+09:00',
        '',
        'Lead:',
        '- Name: 山田太郎',
        '- Org: Example株式会社',
        '- Email: taro@example.com',
        '',
        'Message:',
        '社内の承認業務を自動化したいです。',
        '',
        'Metadata:',
        '  {',
        '    "page": "/contact",',
        '    "utm_source": "google"',
        '  }',
        '',
      ].join('\n'),
    );
  });
});

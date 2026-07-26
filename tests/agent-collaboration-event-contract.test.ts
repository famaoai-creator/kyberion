import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { safeReadFile, safeExistsSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

describe('agent collaboration event contract', () => {
  it('publishes and validates the v1 schema', () => {
    const schemaPath = pathResolver.knowledge(
      'product/schemas/agent-collaboration-event.schema.json'
    );
    expect(safeExistsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(String(safeReadFile(schemaPath, { encoding: 'utf8' })));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(
      validate({
        schema_version: 'agent-collaboration-event.v1',
        event_id: 'ACE-1',
        source_event_id: 'task-1',
        ts: '2026-07-26T00:00:00Z',
        seq: 0,
        actor_type: 'agent',
        kind: 'progress',
        summary: 'step started',
        related_ids: [],
        evidence_refs: [],
        redaction: 'summary',
        source: 'task',
      })
    ).toBe(true);
  });
});

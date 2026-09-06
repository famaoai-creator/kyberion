import { afterEach, describe, expect, it } from 'vitest';

import { readTextFile } from '@agent/core/foundation';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { filterAuditChainByMission } from './export_validation_bundle.js';

const AUDIT_FIXTURE_DIR = pathResolver.sharedTmp('export-validation-bundle-audit.test');
const MISSION_ID = 'MSN-BUNDLE-1';

afterEach(() => {
  safeRmSync(AUDIT_FIXTURE_DIR, { recursive: true, force: true });
});

describe('validation bundle audit projection', () => {
  it('uses the foundation JSONL reader for audit projection', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/export_validation_bundle.ts'));
    expect(source).toContain('nowIso, readJsonLines');
    expect(source).toContain('readJsonLines<Record<string, unknown>>');
  });

  it('projects only shape-valid audit entries for the requested mission', () => {
    safeMkdir(AUDIT_FIXTURE_DIR, { recursive: true });
    const valid = {
      id: 'audit-1',
      timestamp: new Date().toISOString(),
      agentId: 'operator',
      action: 'rubric.override_accepted',
      operation: `mission:${MISSION_ID}`,
      result: 'completed',
      previousHash: '0'.repeat(64),
      currentHash: '1'.repeat(64),
    };
    const unrelated = { ...valid, id: 'audit-2', operation: 'mission:MSN-OTHER' };
    safeWriteFile(
      `${AUDIT_FIXTURE_DIR}/events.jsonl`,
      [
        JSON.stringify(valid),
        JSON.stringify(unrelated),
        JSON.stringify(['malformed']),
        '{bad',
      ].join('\n')
    );

    const result = filterAuditChainByMission(AUDIT_FIXTURE_DIR, MISSION_ID);
    expect(result.allEvents).toHaveLength(1);
    expect(result.overrideEvents).toHaveLength(1);
    expect(result.allEvents[0]?.id).toBe('audit-1');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import * as pathResolver from './path-resolver.js';
// Install the full identity resolver (MISSION_ROLE / tenant resolution) the
// production read path uses, instead of the bootstrap fallback.
import './authority.js';

// The tier guard emits best-effort audit events on denial; keep them off the
// real audit chain so the suite stays hermetic.
vi.mock('./governance/audit-chain.js', () => ({
  auditChain: {
    record: vi.fn(),
  },
}));

const ROOT = pathResolver.rootDir();
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ENTITY_GOVERNANCE',
] as const;

const at = (relative: string): string => path.join(ROOT, relative);

describe('tier-guard peer_task_artifact_writer authority role', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.MISSION_ROLE = 'peer_task_artifact_writer';
    process.env.KYBERION_TENANT = 'acme-corp';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const TASK_DIR = 'active/shared/artifacts/confidential/acme-corp/report/peer-tasks/ptk-1';

  it('writes and reads only its tenant peer-task reports and that tenant artifact index', () => {
    for (const relative of [
      `${TASK_DIR}/report.json`,
      `${TASK_DIR}/output.log`,
      'active/shared/artifacts/confidential/acme-corp/artifacts-index.jsonl',
    ]) {
      expect(validateWritePermission(at(relative)), relative).toEqual({ allowed: true });
      expect(validateReadPermission(at(relative)), relative).toEqual({ allowed: true });
    }
  });

  // Writes to the tenant artifact floor are not tier-gated per role today; the
  // read side (index lstat, directory checks) is, and it stays this narrow.
  it('never reads another tenant, another artifact class or other confidential state', () => {
    for (const relative of [
      'active/shared/artifacts/confidential/other-co/report/peer-tasks/ptk-1/report.json',
      'active/shared/artifacts/confidential/other-co/artifacts-index.jsonl',
      'active/shared/artifacts/confidential/acme-corp/report/front-desk/x.json',
      'active/shared/artifacts/confidential/acme-corp/evidence/x.json',
      'knowledge/confidential/acme-corp/connections/peer-network.json',
      'knowledge/personal/tenants/acme-corp.json',
    ]) {
      expect(validateReadPermission(at(relative)).allowed, relative).toBe(false);
    }
  });
});

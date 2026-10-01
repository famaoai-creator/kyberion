// Team Channel E: the Slack bridge reads tenant knowledge (and the tenant
// profile that locates it) only for the tenant bound to the current team turn
// — never another tenant's, never unbound.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { validateReadPermission } from './tier-guard.js';
import * as pathResolver from './path-resolver.js';
import { withExecutionContextAsync } from './authority.js';

vi.mock('./governance/audit-chain.js', () => ({
  auditChain: {
    record: vi.fn(),
  },
}));

const ROOT = pathResolver.rootDir();
const ENV_KEYS = ['KYBERION_TENANT', 'KYBERION_PERSONA', 'MISSION_ROLE', 'KYBERION_SUDO'] as const;

function knowledge(rel: string): string {
  return path.join(ROOT, 'knowledge', rel);
}

describe('tier-guard slack_bridge tenant-bound knowledge reads', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.MISSION_ROLE = 'slack_bridge';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('reads the bound tenant knowledge and profile only', async () => {
    await withExecutionContextAsync(
      'slack_bridge',
      () => {
        expect(validateReadPermission(knowledge('confidential/acme/runbook.md')).allowed).toBe(
          true
        );
        expect(validateReadPermission(knowledge('personal/tenants/acme.json')).allowed).toBe(true);
        expect(validateReadPermission(knowledge('personal/tenants/globex.json')).allowed).toBe(
          false
        );
        expect(validateReadPermission(knowledge('confidential/globex/plan.md')).allowed).toBe(
          false
        );
        expect(validateReadPermission(knowledge('personal/owner-notes.md')).allowed).toBe(false);
      },
      undefined,
      'acme'
    );
  });

  it('reads no tenant knowledge when no tenant is bound', () => {
    expect(validateReadPermission(knowledge('confidential/acme/runbook.md')).allowed).toBe(false);
    expect(validateReadPermission(knowledge('personal/tenants/acme.json')).allowed).toBe(false);
  });
});

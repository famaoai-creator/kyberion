import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

// Role deny_read carve-outs must hold on the path that is physically read:
// (1) through a symlink whose lexical spelling escapes the carved-out prefix,
// and (2) on the partitioned runtime-ledger branch, whose allow decisions
// judge a knowledge/<tier> mirror path rather than the real ledger path.

const state = vi.hoisted(() => ({
  // lexical absolute path -> physical absolute path (symlink stand-ins)
  realpaths: new Map<string, string>(),
  extraDenyRead: [] as string[],
}));

vi.mock('./fs-primitives.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs-primitives.js')>();
  return {
    ...actual,
    rawRealpathSync: (target: string) => {
      const mapped = state.realpaths.get(target);
      if (mapped) return mapped;
      return actual.rawRealpathSync(target);
    },
    rawReadTextFile: (target: string) => {
      const text = actual.rawReadTextFile(target);
      if (!target.endsWith('security-policy.json') || state.extraDenyRead.length === 0) {
        return text;
      }
      const policy = JSON.parse(text);
      const role = policy.authority_role_permissions.peer_responder_reader;
      role.deny_read = [...(role.deny_read ?? []), ...state.extraDenyRead];
      return JSON.stringify(policy);
    },
  };
});

vi.mock('./governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

import { validateReadPermission } from './tier-guard.js';
import * as pathResolver from './path-resolver.js';
import './authority.js';

const ROOT = pathResolver.rootDir();
const at = (relative: string): string => path.join(ROOT, relative);
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

describe('tier-guard deny_read on resolved paths', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.MISSION_ROLE = 'peer_responder_reader';
    process.env.KYBERION_TENANT = 'acme-corp';
    state.realpaths.clear();
    state.extraDenyRead = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('denies a symlinked spelling that physically resolves into the carve-out', () => {
    const link = at('knowledge/confidential/acme-corp/notes/link');
    state.realpaths.set(link, at('knowledge/confidential/acme-corp/connections'));
    const decision = validateReadPermission(path.join(link, 'peer-network.json'));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/deny_read/);
  });

  it('keeps an unlinked sibling readable (control)', () => {
    expect(
      validateReadPermission(at('knowledge/confidential/acme-corp/notes/link/peer-network.json'))
    ).toEqual({ allowed: true });
  });

  it('applies deny_read to the real path on the partitioned runtime-ledger branch', () => {
    const ledger = 'active/shared/runtime/usage-ledger/confidential/acme-corp/resource-usage.jsonl';
    // Without a carve-out the role reads its own tenant partition through the
    // knowledge/confidential/<tenant> mirror.
    expect(validateReadPermission(at(ledger))).toEqual({ allowed: true });

    state.extraDenyRead = ['active/shared/runtime/usage-ledger/confidential/${KYBERION_TENANT}/'];
    for (const spelling of [
      ledger,
      ledger.replace(
        'usage-ledger/confidential/acme-corp',
        'usage-ledger/confidential/acme-corp/./'
      ),
    ]) {
      const decision = validateReadPermission(at(spelling));
      expect(decision.allowed, spelling).toBe(false);
      expect(decision.reason, spelling).toMatch(/deny_read/);
    }
  });
});

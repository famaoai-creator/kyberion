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

describe('tier-guard peer_responder_reader authority role', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.MISSION_ROLE = 'peer_responder_reader';
    process.env.KYBERION_TENANT = 'acme-corp';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('reads the bound tenant profile, confidential knowledge and customer overlay', () => {
    for (const relative of [
      'knowledge/personal/tenants/acme-corp.json',
      'knowledge/confidential/acme-corp/notes/handbook.md',
      'customer/acme-corp/customer.json',
    ]) {
      expect(validateReadPermission(at(relative)), relative).toEqual({ allowed: true });
    }
  });

  it('never reads another tenant, other personal files, or the shared confidential tier', () => {
    for (const relative of [
      'knowledge/personal/tenants/other-corp.json',
      'knowledge/personal/my-identity.json',
      'knowledge/confidential/other-corp/notes/handbook.md',
      'knowledge/confidential/common/glossary.md',
    ]) {
      expect(validateReadPermission(at(relative)).allowed, relative).toBe(false);
    }
  });

  it('never reads the bound tenant connection secrets (deny_read carve-out)', () => {
    for (const relative of [
      'knowledge/confidential/acme-corp/connections/peer-network.json',
      'knowledge/confidential/acme-corp/connections/',
      'knowledge/confidential/acme-corp/connections/nested/notes.md',
    ]) {
      const decision = validateReadPermission(at(relative));
      expect(decision.allowed, relative).toBe(false);
      expect(decision.reason, relative).toMatch(/deny_read/);
    }
    // The carve-out is exact: a sibling whose name only starts with
    // `connections` stays readable.
    expect(
      validateReadPermission(at('knowledge/confidential/acme-corp/connections-notes.md'))
    ).toEqual({ allowed: true });
  });

  it('the peer catalog reader still reads the bound tenant peer catalog', () => {
    process.env.MISSION_ROLE = 'peer_catalog_reader';
    expect(
      validateReadPermission(at('knowledge/confidential/acme-corp/connections/peer-network.json'))
    ).toEqual({ allowed: true });
  });

  // customer/ overlays and active/shared/runtime/ are not tier-protected
  // paths, so the role adds nothing there; only its confidential/personal
  // grants are asserted.
  it('writes nothing in the tiers it can read, not even inside its own tenant', () => {
    for (const relative of [
      'knowledge/personal/tenants/acme-corp.json',
      'knowledge/confidential/acme-corp/notes/handbook.md',
    ]) {
      expect(validateWritePermission(at(relative)).allowed, relative).toBe(false);
    }
  });
});

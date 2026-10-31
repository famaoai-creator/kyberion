import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { validateWritePermission } from './tier-guard.js';
import { withExecutionContext } from './authority.js';
import * as pathResolver from './path-resolver.js';
// Install the full identity resolver (MISSION_ROLE / tenant resolution) the
// production write path uses, instead of the bootstrap fallback.
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
  'KYBERION_TIER',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_SCOPE_ENV_PATH',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ENTITY_GOVERNANCE',
] as const;

const at = (relative: string): string => path.join(ROOT, relative);
const RECEIPT = 'dist/.build-generation.json';

/**
 * `pnpm run build` resolves its authority role from the argv basename —
 * `build_repository`. The R12 receipt writer is the one governed write the
 * build performs into `dist/` (compiler output lands via child processes);
 * its grant names the exact receipt file, nothing else.
 */
describe('tier-guard build_repository receipt grant', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('the bare interactive identity cannot write the receipt', () => {
    expect(validateWritePermission(at(RECEIPT)).allowed).toBe(false);
  });

  it('the build role may write exactly dist/.build-generation.json', () => {
    withExecutionContext('build_repository', () => {
      expect(validateWritePermission(at(RECEIPT)).allowed).toBe(true);
    });
  });

  it('the grant never widens to other dist paths or other trees', () => {
    withExecutionContext('build_repository', () => {
      for (const relative of [
        // Same directory, different file — the grant is an exact leaf, not
        // a dist/ prefix.
        'dist/.session-build-head',
        'dist/index.js',
        'dist/scripts/build_repository.js',
        'dist/.build-generation.json.bak',
        // Anything outside the exact leaf stays denied: other dist files,
        // knowledge tiers, and governance files the build never writes.
        'knowledge/product/governance/security-policy.json',
        'knowledge/personal/tenants/acme-corp.json',
        'knowledge/confidential/acme-corp/notes.md',
        'CHANGELOG.md',
      ]) {
        expect(validateWritePermission(at(relative)).allowed, relative).toBe(false);
      }
    });
  });
});

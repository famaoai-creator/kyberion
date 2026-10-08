import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { currentExecutionScope, scopedAssumedRole } from '../foundation/execution-scope.js';
import { pathResolver } from '../path-resolver.js';
import { validateWritePermission } from '../tier-guard.js';
import { auditChain, registerAuditChainIo, type AuditChainIo } from './audit-chain.js';

// G17: under a company stance, `pnpm work create-item` recorded its audit
// entry inside work coordination's infrastructure_sentinel store fence, so the
// tenant mirror (customer/{slug}/logs/audit/) was written as an unbound
// sentinel and denied. The mirror is the chain's own store: it is written as
// infrastructure_sentinel bound to the entry's tenant, whatever the caller is.
const TENANT = 'mirror-authority-co';
const OTHER_TENANT = 'mirror-other-co';
const ENV_KEYS = ['KYBERION_PERSONA', 'MISSION_ROLE', 'KYBERION_SUDO', 'KYBERION_TENANT'] as const;

function mirrorPath(slug: string): string {
  return path.join(pathResolver.rootDir(), 'customer', slug, 'logs', 'audit', 'audit-x.jsonl');
}

describe('audit chain tenant mirror authority', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.MISSION_ROLE;
    delete process.env.KYBERION_SUDO;
    delete process.env.KYBERION_TENANT;
    process.env.KYBERION_PERSONA = 'sovereign';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('grants the tenant-bound store-writer only its own tenant mirror', () => {
    const allowed = (slug: string | undefined, file: string): boolean =>
      withExecutionContext(
        'infrastructure_sentinel',
        () => validateWritePermission(file).allowed,
        undefined,
        slug
      );

    expect(allowed(TENANT, mirrorPath(TENANT))).toBe(true);
    expect(allowed(TENANT, mirrorPath(OTHER_TENANT))).toBe(false);
    expect(allowed(undefined, mirrorPath(TENANT))).toBe(false);
    expect(
      allowed(TENANT, path.join(pathResolver.rootDir(), 'customer', TENANT, 'customer.json'))
    ).toBe(false);
  });

  it('writes the mirror as the tenant-bound writer even inside an unbound sentinel fence', () => {
    const appends: Array<{
      file: string;
      role: string | undefined;
      tenant: string | undefined;
      allowed: boolean;
    }> = [];
    const io: AuditChainIo = {
      read: () => '',
      loadJson: <T>() => ({}) as T,
      exists: (file) => file.includes(`${path.sep}customer${path.sep}`),
      mkdir: () => undefined,
      readdir: () => [],
      append: (file) => {
        appends.push({
          file,
          role: scopedAssumedRole(),
          tenant: currentExecutionScope()?.tenantSlug,
          allowed: validateWritePermission(file).allowed,
        });
      },
      assertSafePath: (file) => file,
    };
    registerAuditChainIo(io);

    // Same shape as work coordination's store fence (G17 reproduction).
    withExecutionContext('infrastructure_sentinel', () =>
      auditChain.record({
        agentId: 'sovereign',
        action: 'work_item.created',
        operation: 'create:WI-G17',
        result: 'completed',
        tenantSlug: TENANT,
      })
    );

    const mirror = appends.find((entry) => entry.file.includes(`customer${path.sep}${TENANT}`));
    expect(mirror).toEqual({
      file: expect.stringContaining(path.join('customer', TENANT, 'logs', 'audit')),
      role: 'infrastructure_sentinel',
      tenant: TENANT,
      allowed: true,
    });
    // The master chain is unaffected: it is written under the caller's context.
    const master = appends.find((entry) => entry !== mirror);
    expect(master?.file).toContain(path.join('shared', 'logs', 'audit'));
    expect(master?.tenant).toBeUndefined();
  });
});

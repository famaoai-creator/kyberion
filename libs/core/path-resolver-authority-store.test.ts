import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shared authority-store resolution (one store per repository): in a linked
 * git worktree the charter/approval subtrees resolve under the primary
 * checkout while every other path stays checkout-local. The resolver binds
 * the root at import, so each case reloads the module with KYBERION_ROOT
 * pointed at a synthetic worktree.
 */

function makeCheckout(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}');
  writeFileSync(path.join(dir, 'AGENTS.md'), '# fixture');
  mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
}

function makeLinkedWorktree(primary: string, worktree: string): void {
  makeCheckout(worktree);
  const gitDir = path.join(primary, '.git', 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
}

async function loadResolver(root: string) {
  vi.resetModules();
  vi.stubEnv('KYBERION_ROOT', root);
  // The production remap must be observable: neutralize the Vitest short-circuits.
  vi.stubEnv('VITEST', '');
  return import('./path-resolver.js');
}

let tmp: string;
let primary: string;
let worktree: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'kyberion-authority-root-'));
  primary = path.join(tmp, 'primary');
  worktree = path.join(tmp, 'worktrees', 'wt');
  makeCheckout(primary);
  mkdirSync(path.join(primary, '.git'), { recursive: true });
  makeLinkedWorktree(primary, worktree);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('primary-checkout authority store resolution', () => {
  it('detects the primary checkout from a linked worktree .git file', async () => {
    const resolver = await loadResolver(worktree);
    expect(resolver.primaryCheckoutRootDir()).toBe(primary);
  });

  it('treats a normal checkout (git directory) as its own primary', async () => {
    const resolver = await loadResolver(primary);
    expect(resolver.primaryCheckoutRootDir()).toBe(primary);
  });

  it('resolves charter and approval-store paths into the primary checkout', async () => {
    const resolver = await loadResolver(worktree);
    expect(resolver.resolve('knowledge/personal/charters/chr-1.json')).toBe(
      path.join(primary, 'knowledge/personal/charters/chr-1.json')
    );
    expect(
      resolver.resolve(
        'active/shared/coordination/channels/external-operation/approvals/requests/r.json'
      )
    ).toBe(
      path.join(
        primary,
        'active/shared/coordination/channels/external-operation/approvals/requests/r.json'
      )
    );
    expect(
      resolver.shared('coordination/channels/onboarding/approvals/passkey-challenges/c.json')
    ).toBe(
      path.join(
        primary,
        'active/shared/coordination/channels/onboarding/approvals/passkey-challenges/c.json'
      )
    );
    expect(resolver.resolve('active/shared/observability/channels/terminal/approvals.jsonl')).toBe(
      path.join(primary, 'active/shared/observability/channels/terminal/approvals.jsonl')
    );
    expect(resolver.resolve('active/shared/runtime/tenant-approvals/acme/x.json')).toBe(
      path.join(primary, 'active/shared/runtime/tenant-approvals/acme/x.json')
    );
    expect(resolver.resolve('knowledge/confidential/acme/charters/chr-2.json')).toBe(
      path.join(primary, 'knowledge/confidential/acme/charters/chr-2.json')
    );
  });

  it('keeps non-authority paths checkout-local', async () => {
    const resolver = await loadResolver(worktree);
    expect(resolver.resolve('knowledge/personal/notes/n.json')).toBe(
      path.join(worktree, 'knowledge/personal/notes/n.json')
    );
    expect(resolver.resolve('active/shared/coordination/channels/slack/outbox/m.json')).toBe(
      path.join(worktree, 'active/shared/coordination/channels/slack/outbox/m.json')
    );
    expect(resolver.resolve('knowledge/confidential/acme/registry/t.json')).toBe(
      path.join(worktree, 'knowledge/confidential/acme/registry/t.json')
    );
  });

  it('spells authority paths with their canonical repo-relative form', async () => {
    const resolver = await loadResolver(worktree);
    const primaryFile = path.join(primary, 'knowledge/personal/charters/chr-1.json');
    const worktreeFile = path.join(worktree, 'knowledge/personal/charters/chr-1.json');
    expect(resolver.storeRelativePath(primaryFile)).toBe('knowledge/personal/charters/chr-1.json');
    expect(resolver.storeRelativePath(worktreeFile)).toBe('knowledge/personal/charters/chr-1.json');
    expect(
      resolver.storeRelativePath(path.join(primary, 'knowledge/personal/notes/n.json'))
    ).toContain('..');
  });

  it('admits only authority subtrees under the primary root as governed', async () => {
    const resolver = await loadResolver(worktree);
    expect(
      resolver.isWithinGovernedRoots(path.join(primary, 'knowledge/personal/charters/c.json'))
    ).toBe(true);
    expect(
      resolver.isWithinGovernedRoots(path.join(primary, 'knowledge/personal/notes/n.json'))
    ).toBe(false);
    expect(resolver.isWithinGovernedRoots(path.join(worktree, 'package.json'))).toBe(true);
    expect(resolver.isWithinGovernedRoots(path.join(tmp, 'elsewhere/x'))).toBe(false);
  });

  it('matches only the declared authority prefixes', async () => {
    const resolver = await loadResolver(worktree);
    expect(resolver.isAuthorityStoreRelativePath('knowledge/personal/charters/x.json')).toBe(true);
    expect(
      resolver.isAuthorityStoreRelativePath('knowledge/confidential/acme/charters/x.json')
    ).toBe(true);
    expect(resolver.isAuthorityStoreRelativePath('knowledge/personal/charters')).toBe(true);
    expect(resolver.isAuthorityStoreRelativePath('knowledge/personal/charterless/x.json')).toBe(
      false
    );
    expect(
      resolver.isAuthorityStoreRelativePath(
        'active/shared/coordination/channels/slack/approvals/requests/r.json'
      )
    ).toBe(true);
    expect(
      resolver.isAuthorityStoreRelativePath(
        'active/shared/coordination/channels/slack/outbox/m.json'
      )
    ).toBe(false);
    expect(
      resolver.isAuthorityStoreRelativePath(
        'active/shared/observability/channels/slack/approvals.jsonl'
      )
    ).toBe(true);
    expect(
      resolver.isAuthorityStoreRelativePath(
        'active/shared/observability/channels/slack/approvals2.jsonl'
      )
    ).toBe(false);
  });
});

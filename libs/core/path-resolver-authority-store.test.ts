import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    // The channels root is the storage-channel enumeration point — without it
    // a linked worktree lists its own empty dir and system requests vanish.
    expect(resolver.resolve('active/shared/coordination/channels')).toBe(
      path.join(primary, 'active/shared/coordination/channels')
    );
    expect(resolver.resolve('active/shared/observability/channels')).toBe(
      path.join(primary, 'active/shared/observability/channels')
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
    expect(resolver.isAuthorityStoreRelativePath('active/shared/coordination/channels')).toBe(true);
    expect(resolver.isAuthorityStoreRelativePath('active/shared/observability/channels')).toBe(
      true
    );
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

  it('admits the per-channel directory itself, not its other contents', async () => {
    // A first approval in a fresh primary checkout creates
    // `channels/<channel>/` there: the directory must be governed authority
    // state or the mkdir / ancestor probe is refused as outside the repository.
    const resolver = await loadResolver(worktree);
    for (const root of ['coordination', 'observability']) {
      expect(resolver.isAuthorityStoreRelativePath(`active/shared/${root}/channels/slack`)).toBe(
        true
      );
      expect(resolver.isAuthorityStoreRelativePath(`active/shared/${root}/channels/slack/`)).toBe(
        false
      );
    }
    expect(
      resolver.isAuthorityStoreRelativePath('active/shared/coordination/channels/slack/outbox')
    ).toBe(false);
  });

  it('names only the fixed ancestors of the authority stores, never their siblings', async () => {
    const resolver = await loadResolver(worktree);
    for (const rel of [
      'active',
      'active/shared',
      'active/shared/coordination',
      'active/shared/observability',
      'active/shared/runtime',
      'knowledge',
      'knowledge/personal',
      'knowledge/confidential',
      'knowledge/confidential/acme',
    ]) {
      expect(resolver.isAuthorityStoreAncestorRelativePath(rel)).toBe(true);
    }
    for (const rel of [
      '',
      'active/shared/coordination/channels',
      'active/shared/coordination/inbox',
      'active/shared/runtime/other',
      'knowledge/public',
      'knowledge/confidential/acme/notes',
    ]) {
      expect(resolver.isAuthorityStoreAncestorRelativePath(rel)).toBe(false);
    }
  });

  it('lets a linked worktree resolve the first approval path when the primary has no channels/', async () => {
    // A primary checkout whose active/shared/coordination exists but has never
    // held an approval: the missing-ancestor walk climbs past channels/ and
    // used to refuse the existence probe of coordination/ as outside the repo.
    mkdirSync(path.join(primary, 'active', 'shared', 'coordination'), { recursive: true });
    await loadResolver(worktree);
    const guard = await import('./secure-io-path-guard.js');
    const requests = path.join(
      primary,
      'active/shared/coordination/channels/external-operation/approvals/requests'
    );
    for (const mode of ['follow', 'leaf'] as const) {
      expect(guard.canonicalGuardPath(requests, mode)).toBe(requests);
    }
    expect(guard.entryExists(path.join(primary, 'active/shared/coordination'))).toBe(true);
    // Non-authority paths in the primary stay outside: the ancestor probe grants nothing.
    expect(() =>
      guard.entryExists(path.join(primary, 'active/shared/coordination/inbox'))
    ).toThrow();
    expect(() =>
      guard.canonicalGuardPath(path.join(primary, 'active/shared/coordination/inbox/x'), 'leaf')
    ).toThrow();
  });

  it('creates the first approval directory in a primary whose real path differs from its spelling', async () => {
    // The primary is reached through a symlink (deliberately, so this holds on
    // every platform, not only where tmpdir itself is symlinked). mkdirGuarded
    // compares each parent's canonical path with the checked one, so the
    // ancestor must be spelled back under the logical primary root or the
    // first mkdir is refused.
    const linkedPrimary = path.join(tmp, 'primary-link');
    symlinkSync(primary, linkedPrimary);
    const linkedWorktree = path.join(tmp, 'worktrees', 'wt-linked');
    makeCheckout(linkedWorktree);
    const gitDir = path.join(linkedPrimary, '.git', 'worktrees', 'wt-linked');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(linkedWorktree, '.git'), `gitdir: ${gitDir}\n`);
    mkdirSync(path.join(primary, 'active', 'shared', 'coordination'), { recursive: true });

    const resolver = await loadResolver(linkedWorktree);
    expect(resolver.primaryCheckoutRootDir()).toBe(linkedPrimary);
    const guard = await import('./secure-io-path-guard.js');
    const requests = path.join(
      linkedPrimary,
      'active/shared/coordination/channels/external-operation/approvals/requests'
    );
    const checked = guard.canonicalGuardPath(requests, 'follow');
    expect(checked).toBe(requests);
    guard.mkdirGuarded(requests, checked, requests);
    expect(existsSync(requests)).toBe(true);
    // The ancestor walk creates nothing outside the authority stores.
    const inbox = path.join(linkedPrimary, 'active/shared/coordination/inbox/x');
    expect(() => guard.mkdirGuarded(inbox, inbox, inbox)).toThrow();
    expect(existsSync(path.join(primary, 'active/shared/coordination/inbox'))).toBe(false);
  });

  it('round-trips authority stores and their ancestors through the root translators', async () => {
    // toLogicalRoot and toPhysicalRoot must be inverses for every primary path
    // either one re-spells; a path only one direction knows breaks the
    // physical-prefix open (macOS O_NOFOLLOW_ANY) or the parent comparison.
    const linkedPrimary = path.join(tmp, 'primary-link');
    symlinkSync(primary, linkedPrimary);
    const linkedWorktree = path.join(tmp, 'worktrees', 'wt-linked');
    makeCheckout(linkedWorktree);
    const gitDir = path.join(linkedPrimary, '.git', 'worktrees', 'wt-linked');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(linkedWorktree, '.git'), `gitdir: ${gitDir}\n`);

    await loadResolver(linkedWorktree);
    const guard = await import('./secure-io-path-guard.js');
    const { toLogicalRoot, toPhysicalRoot } = guard.rootTranslationForTesting;
    const realPrimary = realpathSync.native(primary);
    for (const rel of [
      'active/shared/coordination',
      'active/shared/runtime',
      'knowledge/confidential/acme',
      'active/shared/coordination/channels',
      'active/shared/coordination/channels/external-operation/approvals/requests',
      'knowledge/personal/charters/x.json',
    ]) {
      const logical = path.join(linkedPrimary, rel);
      const physical = path.join(realPrimary, rel);
      expect(toPhysicalRoot(logical)).toBe(physical);
      expect(toLogicalRoot(physical)).toBe(logical);
      expect(toLogicalRoot(toPhysicalRoot(logical))).toBe(logical);
    }
    // Non-authority primary paths are translated by neither direction.
    const inbox = path.join(linkedPrimary, 'active/shared/coordination/inbox');
    expect(toPhysicalRoot(inbox)).toBe(inbox);
    const realInbox = path.join(realPrimary, 'active/shared/coordination/inbox');
    expect(toLogicalRoot(realInbox)).toBe(realInbox);
  });

  it('does not create a missing ancestor of the authority store', async () => {
    // Precondition of the fix: the fixed ancestors must already exist in the
    // primary. When coordination/ itself is missing, nothing is created.
    mkdirSync(path.join(primary, 'active', 'shared'), { recursive: true });
    await loadResolver(worktree);
    const guard = await import('./secure-io-path-guard.js');
    const requests = path.join(
      primary,
      'active/shared/coordination/channels/external-operation/approvals/requests'
    );
    expect(() => guard.mkdirGuarded(requests, requests, requests)).toThrow();
    expect(existsSync(path.join(primary, 'active/shared/coordination'))).toBe(false);
  });

  it('refuses a dangling-symlink ancestor in the primary', async () => {
    mkdirSync(path.join(primary, 'active', 'shared'), { recursive: true });
    symlinkSync(path.join(tmp, 'nowhere'), path.join(primary, 'active/shared/coordination'));
    await loadResolver(worktree);
    const guard = await import('./secure-io-path-guard.js');
    expect(() =>
      guard.canonicalGuardPath(
        path.join(primary, 'active/shared/coordination/channels/external-operation/approvals'),
        'follow'
      )
    ).toThrow();
  });
});

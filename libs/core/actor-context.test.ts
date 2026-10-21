import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentityContext } from './types.js';

const runtime = vi.hoisted(() => ({
  identity: {
    persona: 'worker',
    executionMode: 'mission',
    authorities: [],
    role: 'worker',
  } as IdentityContext,
}));
vi.mock('./authority.js', () => ({ resolveIdentityContext: () => runtime.identity }));

import { humanActor } from './actor.js';
import { currentActor, resolveActorContext, withActorContext } from './actor-context.js';
import { KNOWLEDGE_TIERS, KNOWLEDGE_TIER_RANK } from './foundation/knowledge-tier.js';

const input = (member = 'alice') => ({
  actor: humanActor(member),
  scope: { tier: 'public' as const },
  provenance: 'explicit' as const,
});

afterEach(() => {
  runtime.identity = {
    persona: 'worker',
    executionMode: 'mission',
    authorities: [],
    role: 'worker',
  };
});

describe('actor attribution context', () => {
  it('never invents ambient identity and does not retain attribution after dispatch', () => {
    expect(currentActor()).toBeUndefined();
    withActorContext(input(), () => expect(currentActor()?.actor.id).toBe('user:alice'));
    expect(currentActor()).toBeUndefined();
  });

  it('isolates concurrent asynchronous dispatches and restores nesting', async () => {
    await Promise.all(
      ['alice', 'bravo'].map((member) =>
        withActorContext(input(member), async () => {
          await Promise.resolve();
          expect(currentActor()?.actor.id).toBe(`user:${member}`);
          withActorContext(input('charlie'), () =>
            expect(currentActor()?.actor.id).toBe('user:charlie')
          );
          expect(currentActor()?.actor.id).toBe(`user:${member}`);
        })
      )
    );
    expect(currentActor()).toBeUndefined();
  });

  it('re-resolves current authority instead of preserving an elevated snapshot', () => {
    runtime.identity = {
      persona: 'sovereign',
      executionMode: 'sovereign',
      authorities: ['SUDO'],
      role: 'owner',
    };
    withActorContext(input(), () => {
      expect(currentActor()?.authority.sudo).toBe(true);
      runtime.identity = {
        persona: 'worker',
        executionMode: 'mission',
        authorities: [],
        role: 'worker',
      };
      expect(currentActor()?.authority).toMatchObject({
        role: 'worker',
        sudo: false,
        authorities: [],
      });
    });
  });

  it('ignores caller authority fields and rejects cross-tenant attribution', () => {
    const untrusted = {
      ...input(),
      authority: { role: 'owner', authorities: ['SUDO'], sudo: true },
    };
    expect(resolveActorContext(untrusted).authority).toMatchObject({ role: 'worker', sudo: false });
    runtime.identity = { ...runtime.identity, tenantSlug: 'acme' };
    expect(() =>
      resolveActorContext({ ...input(), scope: { tier: 'confidential', tenant_slug: 'other' } })
    ).toThrow('runtime tenant');
  });

  it('rejects malformed actors, invalid scopes and invalid on-behalf-of identity', () => {
    expect(() =>
      resolveActorContext({ ...input(), actor: { kind: 'human', id: 'operator' } })
    ).toThrow('canonical actor');
    expect(() => resolveActorContext({ ...input(), scope: { tier: 'confidential' } })).toThrow();
    expect(() =>
      resolveActorContext({
        ...input(),
        actor: { kind: 'agent', id: 'kyberion://agent/acme/worker', on_behalf_of: 'operator' },
      })
    ).toThrow('on_behalf_of');
  });

  it('freezes copied input and shared tier vocabulary without changing sensitivity order', () => {
    const source = input();
    withActorContext(source, () => {
      source.actor.id = 'user:bravo';
      expect(currentActor()?.actor.id).toBe('user:alice');
      expect(Object.isFrozen(currentActor()?.authority.authorities)).toBe(true);
    });
    expect(
      [...KNOWLEDGE_TIERS].sort((a, b) => KNOWLEDGE_TIER_RANK[a] - KNOWLEDGE_TIER_RANK[b])
    ).toEqual(['public', 'confidential', 'personal']);
    expect(Object.isFrozen(KNOWLEDGE_TIER_RANK)).toBe(true);
  });
});

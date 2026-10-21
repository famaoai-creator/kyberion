import { AsyncLocalStorage } from 'node:async_hooks';
import { agentActor, parseActorRef, type ActorRef } from './actor.js';
import { resolveIdentityContext } from './authority.js';
import { assertScopeContext, type ScopeContext } from './scope-context-validation.js';
import type { Authority, Persona } from './types.js';

/** Attribution projection, never authentication proof or an authorization grant. */
export interface ActorContext {
  readonly actor: Readonly<ActorRef>;
  readonly scope: Readonly<ScopeContext>;
  readonly provenance: 'claim' | 'explicit';
  readonly authority: {
    readonly role?: string;
    readonly persona: Persona;
    readonly authorities: readonly Authority[];
    readonly sudo: boolean;
    readonly sudoScope?: readonly string[];
  };
}

export interface ActorContextInput {
  actor: ActorRef;
  scope: ScopeContext;
  /** A claim means the dispatch claim holder, not a verified human credential. */
  provenance: 'claim' | 'explicit';
}

const STORAGE_KEY = Symbol.for('kyberion.core.actor-context.v1');
type ActorGlobal = typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<Readonly<ActorContextInput>>;
};
const shared = globalThis as ActorGlobal;
const storage = (shared[STORAGE_KEY] ??= new AsyncLocalStorage<Readonly<ActorContextInput>>());

/** Compose canonical decisions; authority is always resolved now, never accepted from input. */
export function resolveActorContext(input: ActorContextInput): ActorContext {
  const actor = parseActorRef(input.actor);
  if (!actor) throw new Error('[ACTOR_CONTEXT_INVALID] canonical actor is required');
  if (actor.kind === 'agent' && actor.on_behalf_of) agentActor(actor.id, actor.on_behalf_of);
  if (input.provenance !== 'claim' && input.provenance !== 'explicit') {
    throw new Error('[ACTOR_CONTEXT_INVALID] attribution provenance is required');
  }
  const scope = assertScopeContext(input.scope, { allowSessionRoot: true });
  const identity = resolveIdentityContext();
  if (identity.tenantSlug && scope.tenant_slug !== identity.tenantSlug) {
    throw new Error('[ACTOR_CONTEXT_INVALID] attribution conflicts with runtime tenant');
  }
  if (identity.missionId && scope.mission_id && identity.missionId !== scope.mission_id) {
    throw new Error('[ACTOR_CONTEXT_INVALID] attribution conflicts with runtime mission');
  }
  return Object.freeze({
    actor: Object.freeze(actor),
    scope: Object.freeze(scope),
    provenance: input.provenance,
    authority: Object.freeze({
      ...(identity.role ? { role: identity.role } : {}),
      persona: identity.persona,
      authorities: Object.freeze([...identity.authorities]),
      sudo: identity.authorities.includes('SUDO'),
      ...(identity.sudoScope ? { sudoScope: Object.freeze([...identity.sudoScope]) } : {}),
    }),
  });
}

/** No ambient attribution means no actor; never guess a person from process env. */
export function currentActor(): ActorContext | undefined {
  const input = storage.getStore();
  return input ? resolveActorContext(input) : undefined;
}

/** Bind attribution only. This neither assumes a role nor changes any permission check. */
export function withActorContext<T>(input: ActorContextInput, fn: () => T): T {
  const resolved = resolveActorContext(input);
  return storage.run(
    Object.freeze({
      actor: resolved.actor,
      scope: resolved.scope,
      provenance: resolved.provenance,
    }),
    fn
  );
}

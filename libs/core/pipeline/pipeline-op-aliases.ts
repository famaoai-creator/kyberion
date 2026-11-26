/**
 * Canonical op-name normalization shared by the runtime dispatcher and static
 * tooling (dry-run assessment, catalog checks). Bare step ops resolve through
 * BARE_OP_ALIASES then default to the `system:` domain; legacy qualified
 * spellings map through QUALIFIED_OP_ALIASES. Keeping one table means a
 * validator's verdict matches what the engine actually dispatches.
 */

/**
 * Actuator action aliases: per domain, an action spelling folded into its
 * canonical action everywhere — the runtime dispatcher (via
 * QUALIFIED_OP_ALIASES), the Run Manifest compiler and the plugin
 * registration check. `browser:navigate` runs as `browser:goto`, so the
 * manifest's "Open <url>" entry and the dispatched op are the same op, and no
 * plugin can register the alias spelling.
 */
export const ACTUATOR_ACTION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  browser: { navigate: 'goto' },
};

/** The canonical action of `domain:action` (itself when it is not an alias). */
export function canonicalActuatorAction(domain: string, action: string): string {
  return Object.hasOwn(ACTUATOR_ACTION_ALIASES, domain) &&
    Object.hasOwn(ACTUATOR_ACTION_ALIASES[domain], action)
    ? ACTUATOR_ACTION_ALIASES[domain][action]
    : action;
}

/** Qualified op aliases: legacy `domain:action` spellings → canonical op. */
export const QUALIFIED_OP_ALIASES: Record<string, string> = {
  'mission:list': 'system:list_missions',
  'project:list': 'system:list_projects',
  'knowledge:list': 'system:list_knowledge',
  'capability:list': 'system:list_capabilities',
  'agent:list-manifests': 'agent:list_manifests',
  'agent:list_manifests': 'agent:list_manifests',
  'agent:list-runtimes': 'agent:list_runtimes',
  'agent:list_runtimes': 'agent:list_runtimes',
  ...Object.fromEntries(
    Object.entries(ACTUATOR_ACTION_ALIASES).flatMap(([domain, actions]) =>
      Object.entries(actions).map(([alias, canonical]) => [
        `${domain}:${alias}`,
        `${domain}:${canonical}`,
      ])
    )
  ),
};

/** Bare control-flow aliases → canonical core:* ops. */
export const BARE_OP_ALIASES: Record<string, string> = {
  if: 'core:if',
  switch: 'core:switch',
  while: 'core:while',
  loop_until: 'core:while',
  retry_until_quality: 'core:retry_until_quality',
  foreach: 'core:foreach',
  parallel_foreach: 'core:parallel_foreach',
  team_lead: 'core:team_lead',
  parallel_calls: 'core:parallel_calls',
  accumulate: 'core:accumulate',
  judge_route: 'core:judge_route',
  await_decision: 'core:await_decision',
  await_state: 'core:await_state',
  include: 'core:include',
};

export function normalizePipelineOp(op: string): string {
  if (op.includes(':')) {
    const [domain, action] = op.split(':');
    const alias = QUALIFIED_OP_ALIASES[op];
    if (alias) return alias;

    if (domain === 'mission') return `system:${action}`;
    return op;
  }
  const alias = BARE_OP_ALIASES[op];
  if (alias) return alias;
  return `system:${op}`;
}

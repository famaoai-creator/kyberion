import {
  collectOperatorHomeSummary,
  type OperatorHomeScopeFilter,
  type OperatorHomeSummary,
} from '@agent/core/operator-home-summary';
import { currentScope, type ScopeContext } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { loadAgentGraph } from './agent-graph.js';

export interface OperatorHomeAgentsWaiting {
  waiting: number;
  humansWaitedOn: number;
}

export interface OperatorHomePacket {
  summary: OperatorHomeSummary;
  scope: ScopeContext;
  /**
   * Best-effort collaboration-tree stats for the cockpit's "who is waiting"
   * line (AC-05). `loadAgentGraph()` is shared (and briefly cached) with the
   * agents panel so a coincident refresh does not read the on-disk
   * collaboration projection twice; a failure here must never fail the
   * cockpit, so it degrades to `undefined`.
   */
  agentsWaiting?: OperatorHomeAgentsWaiting;
}

/** Convert the authoritative runtime scope into read-only home-summary filters. */
export function operatorHomeScopeFilter(scope: ScopeContext): OperatorHomeScopeFilter {
  return {
    tiers: [scope.tier],
    ...(scope.tenant_slug
      ? { tenantSlugs: [scope.tenant_slug] }
      : scope.tier === 'public'
        ? { tenantSlugs: 'all' as const }
        : { tenantSlugs: [] }),
    ...(scope.organization_id ? { organizationIds: [scope.organization_id] } : {}),
    ...(scope.project_id ? { projectIds: [scope.project_id] } : {}),
  };
}

/** Read-only operator packet used by the conversation-first cockpit. */
export async function loadOperatorHome(): Promise<OperatorHomePacket> {
  const scope = currentScope();
  const summary = collectOperatorHomeSummary({
    limit: 5,
    scope: operatorHomeScopeFilter(scope),
  });
  let agentsWaiting: OperatorHomeAgentsWaiting | undefined;
  try {
    const graph = await loadAgentGraph();
    agentsWaiting = {
      waiting: graph.tree.stats.agents_waiting,
      humansWaitedOn: graph.tree.stats.humans_waited_on,
    };
  } catch {
    // Collaboration tree is optional cockpit context.
    agentsWaiting = undefined;
  }
  return { summary, scope, agentsWaiting };
}

export function operatorHomeWatchPaths(): string[] {
  return [
    pathResolver.active('missions'),
    pathResolver.active('shared/runtime'),
    pathResolver.active('shared/coordination/channels'),
    pathResolver.shared('inbox/entries.jsonl'),
    pathResolver.active('shared/coordination/channels'),
    pathResolver.shared('inbox/entries.jsonl'),
  ];
}

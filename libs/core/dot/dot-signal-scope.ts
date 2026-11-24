import * as path from 'node:path';
import { probeSpecId, type StateProbeSpec } from '../pipeline/state-probe.js';
import { dotStatePath } from './dot-state-paths.js';
import type { DotCharter } from './dot-charter.js';

/** Alert sources must be readable under the charter's own data scope. */
export function alertProbes(
  charter: DotCharter
): Map<string, Extract<StateProbeSpec, { type: 'file' }>> {
  const { tenant_slug: tenant, organization_id: org, project_id: project, tier } = charter.scope;
  const roots = ['knowledge/public/', `${dotStatePath(charter)}/`];
  if (tier === 'confidential' && tenant && !project) {
    roots.push(
      org
        ? `knowledge/confidential/${tenant}/organizations/${org}/`
        : `knowledge/confidential/${tenant}/`
    );
  }
  return new Map(
    (charter.goal.signal_probes ?? []).flatMap(({ signal, probe }) => {
      if (probe.type !== 'file' || probe.expect === 'changed') return [];
      const source = path.posix.normalize(probe.path);
      return roots.some((root) => source.startsWith(root))
        ? [[JSON.stringify([signal, probeSpecId(probe)]), probe] as const]
        : [];
    })
  );
}

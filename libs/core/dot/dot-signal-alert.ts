/** A fresh observation can publish one inbox entry per unresolved signal episode. */
import * as path from 'node:path';
import { z } from 'zod';
import {
  evaluateFileStateProbe,
  probeSpecId,
  type StateProbeSpec,
} from '../pipeline/state-probe.js';
import { readJson, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir } from '../secure-io.js';
import { addInboxEntry } from '../task/deliverable-inbox.js';
import { withExecutionContext } from '../authority.js';
import {
  isWithinQuietHours,
  type NotificationQuietHours,
} from '../surface/operator-notifications.js';
import { dotAdmissionScopeHash, withDotAdmissionLock } from './dot-admission-identity.js';
import { dotStatePath } from './dot-state-paths.js';
import type { DotCharter } from './dot-charter.js';
import type { DotSignalEntry } from './dot-feedback.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';

const episodeSchema = z.object({
  version: z.literal(1),
  observed_at: z.number().int().nonnegative(),
  opened_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  status: z.enum(['clear', 'pending', 'published', 'expired']),
});
type Episode = z.infer<typeof episodeSchema>;

export function decideDotSignalAlert(input: {
  prior?: Episode;
  observedAt: number;
  observation: 'healthy' | 'unhealthy' | 'unavailable';
  now: number;
  maxAgeMs: number;
  quiet: boolean;
}): { state?: Episode; publish: boolean } {
  const { prior, observedAt, now, observation } = input;
  const replayPending =
    prior?.status === 'pending' && observedAt === prior.observed_at && observation === 'unhealthy';
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(observedAt) ||
    observedAt < 0 ||
    observedAt > now ||
    now - observedAt >= input.maxAgeMs ||
    (prior && observedAt <= prior.observed_at && !replayPending)
  ) {
    return { state: prior, publish: false };
  }
  if (observation === 'unavailable') {
    return {
      state: prior
        ? { ...prior, observed_at: observedAt }
        : {
            version: 1,
            observed_at: observedAt,
            opened_at: observedAt,
            expires_at: observedAt,
            status: 'clear',
          },
      publish: false,
    };
  }
  if (observation === 'healthy') {
    return {
      state: {
        version: 1,
        observed_at: observedAt,
        opened_at: observedAt,
        expires_at: observedAt,
        status: 'clear',
      },
      publish: false,
    };
  }
  const state: Episode =
    prior && prior.status !== 'clear'
      ? { ...prior, observed_at: observedAt }
      : {
          version: 1,
          observed_at: observedAt,
          opened_at: observedAt,
          expires_at: observedAt + input.maxAgeMs,
          status: 'pending',
        };
  if (state.status === 'pending' && now >= state.expires_at) state.status = 'expired';
  return { state, publish: state.status === 'pending' && !input.quiet };
}

/** Alert sources must be readable under the charter's own data scope. */
function alertProbes(charter: DotCharter): Map<string, Extract<StateProbeSpec, { type: 'file' }>> {
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

export function publishDotSignalAlerts(
  charter: DotCharter,
  observations: DotSignalEntry[],
  deps: {
    now: Date;
    rootDir?: string;
    quietHours?: NotificationQuietHours;
    currentCharter: () => DotCharter;
    enqueue?: typeof addInboxEntry;
  }
): number {
  const policy = charter.notification.signal_alerts;
  if (!policy || !observations.length) return 0;
  const scopeHash = dotAdmissionScopeHash(charter);
  return withDotAdmissionLock(charter, deps.rootDir, () => {
    const current = deps.currentCharter();
    if (
      current.status !== 'active' ||
      current.runtime.execution_mode !== charter.runtime.execution_mode ||
      current.authority.authority_role !== charter.authority.authority_role ||
      dotAdmissionScopeHash(current) !== scopeHash ||
      recoveryEvidenceHash(current.notification) !== recoveryEvidenceHash(charter.notification)
    )
      return 0;
    const probes = alertProbes(current);
    const now = deps.now.getTime();
    const quiet = deps.quietHours ? isWithinQuietHours(deps.now, deps.quietHours) : false;
    let published = 0;
    for (const observation of observations) {
      const probeKey = JSON.stringify([observation.signal, observation.probe_id]);
      const probe = probes.get(probeKey);
      const observedAt = Date.parse(observation.measured_at);
      if (
        observation.dot_id !== current.dot_id ||
        observation.scope_hash !== scopeHash ||
        !probe ||
        !Number.isFinite(observedAt) ||
        observedAt < 0 ||
        now - observedAt >= policy.max_age_s * 1000
      )
        continue;
      const identity = recoveryEvidenceHash([scopeHash, probeKey]);
      const file = path.join(
        deps.rootDir ?? pathResolver.rootDir(),
        dotStatePath(current, 'signal-alerts', `${identity}.json`)
      );
      const prior = safeExistsSync(file) ? episodeSchema.parse(readJson(file)) : undefined;
      const input = {
        prior,
        observedAt,
        now,
        maxAgeMs: policy.max_age_s * 1000,
        quiet,
      };
      let outcome = decideDotSignalAlert({
        ...input,
        observation: observation.unavailable
          ? 'unavailable'
          : observation.healthy
            ? 'healthy'
            : 'unhealthy',
      });
      if (outcome.publish) {
        let recheck: 'healthy' | 'unhealthy' | 'unavailable';
        try {
          recheck = evaluateFileStateProbe(probe, {
            rootDir: deps.rootDir,
            strictFileRead: true,
          }).matched
            ? 'healthy'
            : 'unhealthy';
        } catch {
          recheck = 'unavailable';
        }
        if (recheck === 'healthy') {
          outcome = decideDotSignalAlert({ ...input, prior: undefined, observation: 'healthy' });
        } else if (recheck === 'unavailable') {
          outcome = { ...outcome, publish: false };
        }
      }
      const { state, publish } = outcome;
      if (!state || state === prior) continue;
      safeMkdir(path.dirname(file), { recursive: true });
      // Persist the episode before attempting its idempotent inbox write.
      writeJson(file, state);
      if (!publish) continue;
      const key = recoveryEvidenceHash([identity, state.opened_at]);
      const openedAt = new Date(state.opened_at).toISOString();
      const entry = {
        entryId: `INBOX-DOT-SIGNAL-${key}`,
        kind: 'operator_notification',
        title: 'Dot signal needs attention',
        summary: `${observation.signal} is still outside its expected state. First detected ${openedAt}.`,
        ifAbsent: true,
        scope: {
          ...current.scope,
          provenance_refs: [`dot-signal:${identity}:${openedAt}`],
        },
      };
      if (deps.enqueue) deps.enqueue(entry);
      else {
        withExecutionContext(
          'surface_runtime',
          () => addInboxEntry(entry),
          undefined,
          current.scope.tenant_slug ?? '',
          current.scope.organization_id,
          { projectId: current.scope.project_id ?? null }
        );
      }
      writeJson(file, { ...state, status: 'published' });
      published += 1;
    }
    return published;
  });
}

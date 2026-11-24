/** A fresh observation can publish one inbox entry per unresolved signal episode. */
import * as path from 'node:path';
import { z } from 'zod';
import { hasRatifiedDigestPreference } from './dot-signal-learning.js';
import { alertProbes } from './dot-signal-scope.js';
import { latestDotPreparationIntent } from './dot-inbox.js';
import { evaluateFileStateProbe, probeSpecId } from '../pipeline/state-probe.js';
import { matchesCron } from '../pipeline/cron-utils.js';
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
import { latestDotSignals, type DotSignalEntry } from './dot-feedback.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';

const preparationSchema = z.object({
  confirmed_at: z.number().int().nonnegative(),
  condition: z.enum(['file_missing', 'expectation_unmet']),
  options: z.literal(true).optional(),
  corroboration: z
    .object({
      dot_id: z.string(),
      signal: z.string(),
      measured_at: z.string(),
    })
    .optional(),
});
type Preparation = z.infer<typeof preparationSchema>;

const episodeSchema = z.object({
  version: z.literal(1),
  observed_at: z.number().int().nonnegative(),
  opened_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  status: z.enum(['clear', 'pending', 'published', 'expired']),
  // Undefined is a legacy episode that may already have sent the original payload.
  preparation: preparationSchema.nullable().optional(),
  triage: z
    .object({
      proposed: z.enum(['inbox', 'digest']),
      applied: z.enum(['inbox', 'digest']),
      confirmed_at: z.number().int().nonnegative(),
      learned: z.literal(true).optional(),
    })
    .optional(),
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
          preparation: null,
        };
  if (state.status === 'pending' && now >= state.expires_at) state.status = 'expired';
  if (
    state.status === 'expired' &&
    state.preparation === null &&
    !state.triage &&
    !input.quiet &&
    prior &&
    observedAt > prior.observed_at
  ) {
    state.status = 'pending';
    state.expires_at = observedAt + input.maxAgeMs;
  }
  return { state, publish: state.status === 'pending' && !input.quiet };
}

function summarizeSignalAlert(
  signal: string,
  openedAt: string,
  sourcePath: string,
  preparation?: Preparation | null
): string {
  const summary = `${signal} is still outside its expected state. First detected ${openedAt}.`;
  if (!preparation) return summary;
  const confirmedAt = new Date(preparation.confirmed_at).toISOString();
  const missing = preparation.condition === 'file_missing';
  const observed = missing
    ? 'the expected file was missing'
    : 'the file did not meet the configured expectation';
  const next = missing
    ? 'Check with the source owner whether the file was produced and delivered to the expected location.'
    : 'Check the source file against the Dot’s configured expectation and confirm with the source owner if it changed.';
  const options = preparation.options
    ? ' Options: recheck after the source owner confirms delivery, or escalate the unmet expectation to the responsible operator.'
    : '';
  const peer = preparation.corroboration;
  const related = peer
    ? ` Related observation: ${peer.dot_id} reported ${peer.signal} outside its expectation at ${peer.measured_at}.`
    : '';
  return `${summary} At ${confirmedAt}, ${observed} (${sourcePath}). Next step: ${next}${options}${related}`;
}

function signalEpisodePath(charter: DotCharter, identity: string, rootDir?: string): string {
  return path.join(
    rootDir ?? pathResolver.rootDir(),
    dotStatePath(charter, 'signal-alerts', `${identity}.json`)
  );
}

export function readDotSignalTriage(charter: DotCharter, rootDir?: string) {
  const policy = charter.notification.signal_alerts;
  if (!policy?.mode) return [];
  const scopeHash = dotAdmissionScopeHash(charter);
  return [...alertProbes(charter)].flatMap(([key]) => {
    const file = signalEpisodePath(charter, recoveryEvidenceHash([scopeHash, key]), rootDir);
    try {
      if (!safeExistsSync(file)) return [];
      const state = episodeSchema.parse(readJson(file));
      if (!state.triage) return [];
      const [signal] = JSON.parse(key) as [string, string];
      return [
        {
          signal,
          status: state.status,
          proposed: state.triage.proposed,
          applied: state.triage.applied,
          reason: state.triage.proposed === 'digest' ? 'configured_digest' : 'immediate_inbox',
          confirmed_at: new Date(state.triage.confirmed_at).toISOString(),
          expires_at: new Date(state.expires_at).toISOString(),
        },
      ];
    } catch {
      // Status is observational. A damaged episode cannot produce a decision.
      return [];
    }
  });
}

export function dotSignalTriageEntries(
  charter: DotCharter,
  now: Date,
  rootDir?: string,
  since?: Date
): Array<{ id: string; text: string }> {
  const policy = charter.notification.signal_alerts;
  if (!policy || !charter.notification.digest_cron) return [];
  const scopeHash = dotAdmissionScopeHash(charter);
  const entries: Array<{ id: string; text: string }> = [];
  for (const [key, probe] of alertProbes(charter)) {
    const [signal] = JSON.parse(key) as [string, string];
    const identity = recoveryEvidenceHash([scopeHash, key]);
    const file = signalEpisodePath(charter, identity, rootDir);
    try {
      if (!safeExistsSync(file)) continue;
      const state = episodeSchema.parse(readJson(file));
      if (
        state.status !== 'pending' ||
        state.triage?.applied !== 'digest' ||
        state.expires_at <= now.getTime() ||
        now.getTime() - state.observed_at >= policy.max_age_s * 1000 ||
        (since && state.triage.confirmed_at <= since.getTime())
      )
        continue;
      if (state.triage.learned && !hasRatifiedDigestPreference(charter, signal)) continue;
      if (evaluateFileStateProbe(probe, { rootDir, strictFileRead: true }).matched) continue;
      entries.push({
        id: recoveryEvidenceHash([identity, state.opened_at]),
        text: `- ${signal}: still outside its expected state at the digest recheck.`,
      });
    } catch {
      // Unavailable or invalid evidence cannot justify a digest entry.
      continue;
    }
  }
  return entries;
}

function readCorroboration(
  charter: DotCharter,
  now: number,
  rootDir: string | undefined,
  listPeers: (() => DotCharter[]) | undefined
): Preparation['corroboration'] {
  const policy = charter.notification.signal_alerts;
  const reference = policy?.corroboration;
  if (
    !reference ||
    policy?.mode !== 'prepare' ||
    !listPeers ||
    !charter.team?.accepts_handoffs_from?.includes(reference.dot_id) ||
    reference.dot_id === charter.dot_id
  )
    return undefined;
  try {
    const scope = recoveryEvidenceHash([charter.scope, charter.work_binding ?? null]);
    const peers = listPeers().filter(
      (item) =>
        item.dot_id === reference.dot_id &&
        item.status === 'active' &&
        recoveryEvidenceHash([item.scope, item.work_binding ?? null]) === scope
    );
    const [peer] = peers;
    if (peers.length !== 1 || !peer?.notification.signal_alerts) return undefined;
    const latest = latestDotSignals(peer, { rootDir }).find(
      (item) => item.signal === reference.signal
    )?.latest;
    if (!latest || latest.healthy || latest.unavailable) return undefined;
    const measuredAt = Date.parse(latest.measured_at);
    const age = now - measuredAt;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age >= Math.min(policy.max_age_s, peer.notification.signal_alerts.max_age_s) * 1000
    )
      return undefined;
    return { ...reference, measured_at: new Date(measuredAt).toISOString() };
  } catch {
    return undefined;
  }
}

function hasDigestOpportunity(
  cron: string | undefined,
  now: number,
  expiresAt: number,
  timezone?: string,
  quietHours?: NotificationQuietHours
): boolean {
  if (!cron) return false;
  const firstMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
  const end = Math.min(expiresAt, now + 86_400_000);
  for (let at = firstMinute; at < end; at += 60_000) {
    const scheduled = new Date(at);
    if (
      matchesCron(cron, scheduled, timezone) &&
      (!quietHours || !isWithinQuietHours(scheduled, quietHours))
    )
      return true;
  }
  return false;
}

export function measureDirectedPreparationIntent(
  charter: DotCharter,
  now: Date,
  rootDir?: string
): DotSignalEntry | undefined {
  const policy = charter.notification.signal_alerts;
  if (policy?.mode !== 'prepare' || !policy.directed_intent) return undefined;
  const probes = new Map(
    [...alertProbes(charter)].map(([key, probe]) => {
      const [signal] = JSON.parse(key) as [string, string];
      return [signal, probe] as const;
    })
  );
  const intent = latestDotPreparationIntent(charter, rootDir, now, policy.max_age_s * 1000);
  const probe = intent && probes.get(intent.signal);
  if (!intent || !probe) return undefined;
  try {
    const result = evaluateFileStateProbe(probe, { rootDir, strictFileRead: true });
    return {
      dot_id: charter.dot_id,
      signal: intent.signal,
      probe_id: probeSpecId(probe),
      scope_hash: dotAdmissionScopeHash(charter),
      measured_at: intent.at,
      healthy: result.matched,
    };
  } catch {
    return undefined;
  }
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
    listPeers?: () => DotCharter[];
    digestTimezone?: string;
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
      const file = signalEpisodePath(current, identity, deps.rootDir);
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
      let preparation: Preparation | null | undefined =
        prior && prior.status !== 'clear' ? prior.preparation : null;
      if (outcome.publish) {
        let recheck: 'healthy' | 'unhealthy' | 'unavailable';
        try {
          const result = evaluateFileStateProbe(probe, {
            rootDir: deps.rootDir,
            strictFileRead: true,
          });
          recheck = result.matched ? 'healthy' : 'unhealthy';
          if (recheck === 'unhealthy' && preparation === null) {
            preparation = {
              confirmed_at: now,
              condition: result.fingerprint === 'absent' ? 'file_missing' : 'expectation_unmet',
              ...(policy.mode === 'prepare' ? { options: true } : {}),
              corroboration: readCorroboration(current, now, deps.rootDir, deps.listPeers),
            };
          }
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
      let triage = state.triage;
      // Freeze the delivery lane for the episode. A digest may already have
      // admitted this observation into a durable retryable snapshot.
      if (publish && !triage && policy.mode) {
        const configured = policy.digest_signals?.includes(observation.signal);
        const learned = !configured && hasRatifiedDigestPreference(current, observation.signal);
        const proposed =
          (configured || learned) &&
          hasDigestOpportunity(
            current.notification.digest_cron,
            now,
            state.expires_at,
            deps.digestTimezone,
            deps.quietHours
          )
            ? 'digest'
            : 'inbox';
        triage = {
          proposed,
          applied:
            policy.mode === 'shadow' || (prior?.status === 'pending' && prior.preparation !== null)
              ? 'inbox'
              : proposed,
          confirmed_at: now,
          ...(learned && proposed === 'digest' ? { learned: true } : {}),
        };
      }
      const preparedState = state.status === 'clear' ? state : { ...state, preparation, triage };
      writeJson(file, preparedState);
      if (!publish || triage?.applied === 'digest') continue;
      const key = recoveryEvidenceHash([identity, state.opened_at]);
      const openedAt = new Date(state.opened_at).toISOString();
      const entry = {
        entryId: `INBOX-DOT-SIGNAL-${key}`,
        kind: 'operator_notification',
        title: 'Dot signal needs attention',
        summary: summarizeSignalAlert(
          observation.signal,
          openedAt,
          path.posix.normalize(probe.path),
          preparation
        ),
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
      writeJson(file, { ...preparedState, status: 'published' });
      published += 1;
    }
    return published;
  });
}

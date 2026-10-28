import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { currentScope, type ScopeContext } from './scope-context.js';
import { appendOpsAlertLogRecord } from './ops-alert-log.js';
import { defaultOpsAlertLogPath, readOpsAlertLogRecordsIncludingSegments } from './ops-alert.js';

type IncidentScope = Pick<ScopeContext, 'tier' | 'tenant_slug' | 'organization_id' | 'project_id'>;
export interface SchedulerIncident {
  scheduleId: string;
  signature: string;
  /** Missing for legacy history; such rows cannot be acknowledged. */
  episodeId?: string;
  cause: string;
  status: 'detected' | 'acknowledged' | 'resolved';
  resolvedBy?: 'recovered' | 'superseded';
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  ackUntil?: string;
}
interface IncidentEvent {
  ts: string;
  kind: 'scheduler_incident';
  event_id?: string;
  episode_id?: string;
  schedule_id: string;
  signature: string;
  cause: string;
  event: 'failed' | 'recovered' | 'acknowledged';
  scope: IncidentScope;
  ack_until?: string;
}
export interface SchedulerIncidentOptions {
  alertLogPath?: string;
  now?: Date;
}

/** Test/worktree roots use the same canonical alert log relative to that root. */
export function schedulerIncidentLogForRoot(rootDir?: string): string | undefined {
  return rootDir
    ? path.resolve(rootDir, 'active/shared/observability/ops-alerts.jsonl')
    : undefined;
}
function scopeKey(scope: IncidentScope): string {
  return JSON.stringify([
    scope.tier,
    scope.tenant_slug || null,
    scope.organization_id || null,
    scope.project_id || null,
  ]);
}
function incidentScope(): IncidentScope {
  const scope = currentScope();
  return {
    tier: scope.tier,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope.organization_id ? { organization_id: scope.organization_id } : {}),
    ...(scope.project_id ? { project_id: scope.project_id } : {}),
  };
}
function causeFor(error: string): string {
  if (/429|rate.?limit|quota/i.test(error)) return 'rate_limit';
  if (/401|unauthorized|credential|authentication/i.test(error)) return 'authentication';
  if (/timeout|timed out/i.test(error)) return 'timeout';
  if (/delivery|webhook/i.test(error)) return 'delivery';
  if (/schema|validation|configuration/i.test(error)) return 'configuration';
  return 'execution';
}
/** Error text never enters the shared alert log, only a bounded one-way signature. */
export function schedulerFailureIdentity(error?: string): { cause: string; signature: string } {
  const text = (error || 'unknown failure')
    .slice(0, 4000)
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?|s|minutes?|mins?|hours?|hrs?)\b/g, '#duration')
    .replace(/\s+/g, ' ')
    .trim();
  const cause = causeFor(text);
  return {
    cause,
    signature: createHash('sha256').update(`${cause}\n${text}`).digest('hex').slice(0, 24),
  };
}
function events(options: SchedulerIncidentOptions): IncidentEvent[] {
  const scope = incidentScope();
  return readOpsAlertLogRecordsIncludingSegments(options.alertLogPath)
    .flatMap((record) => {
      const raw = record.raw;
      if (
        record.kind !== 'scheduler_incident' ||
        raw.kind !== 'scheduler_incident' ||
        !raw.scope ||
        typeof raw.scope !== 'object' ||
        scopeKey(raw.scope as IncidentScope) !== scopeKey(scope) ||
        typeof raw.schedule_id !== 'string' ||
        typeof raw.signature !== 'string' ||
        typeof raw.cause !== 'string' ||
        typeof raw.ts !== 'string' ||
        !Number.isFinite(Date.parse(raw.ts)) ||
        !['failed', 'recovered', 'acknowledged'].includes(String(raw.event))
      )
        return [];
      if (Date.parse(raw.ts) > (options.now?.getTime() ?? Date.now())) return [];
      return [raw as unknown as IncidentEvent];
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
export function listSchedulerIncidents(
  options: SchedulerIncidentOptions = {}
): SchedulerIncident[] {
  const now = options.now?.getTime() ?? Date.now();
  const incidents = new Map<string, SchedulerIncident>();
  const seen = new Set<string>();
  for (const event of events(options)) {
    if (event.event_id) {
      if (seen.has(event.event_id)) continue;
      seen.add(event.event_id);
    }
    const key = JSON.stringify([event.schedule_id, event.signature]);
    const previous = incidents.get(key);
    if (event.event === 'failed') {
      // The first observed failure defines the episode. Concurrent repeat writers
      // cannot replace it, and a delayed old producer cannot resurrect a closed id.
      const continuing = previous && previous.status !== 'resolved';
      const episodeId =
        continuing && previous.episodeId
          ? previous.episodeId
          : event.episode_id && event.episode_id !== previous?.episodeId
            ? event.episode_id
            : event.event_id;
      for (const incident of incidents.values())
        if (
          incident.scheduleId === event.schedule_id &&
          incident.signature !== event.signature &&
          incident.status !== 'resolved'
        ) {
          incident.status = 'resolved';
          incident.resolvedBy = 'superseded';
        }
      const acknowledged =
        previous?.status === 'acknowledged' &&
        previous.episodeId === episodeId &&
        Date.parse(previous.ackUntil || '') > Date.parse(event.ts);
      incidents.set(key, {
        scheduleId: event.schedule_id,
        signature: event.signature,
        ...(episodeId ? { episodeId } : {}),
        cause: event.cause,
        firstSeenAt: previous?.firstSeenAt || event.ts,
        lastSeenAt: event.ts,
        occurrences: (previous?.occurrences || 0) + 1,
        status: acknowledged ? 'acknowledged' : 'detected',
        ...(acknowledged ? { ackUntil: previous!.ackUntil } : {}),
      });
    } else if (event.event === 'recovered') {
      for (const incident of incidents.values())
        if (
          incident.scheduleId === event.schedule_id &&
          incident.status !== 'resolved' &&
          (event.episode_id ? incident.episodeId === event.episode_id : !incident.episodeId)
        ) {
          incident.status = 'resolved';
          incident.resolvedBy = 'recovered';
          incident.lastSeenAt = event.ts;
        }
    } else if (
      previous?.status === 'detected' &&
      typeof event.episode_id === 'string' &&
      previous.episodeId === event.episode_id &&
      typeof event.ack_until === 'string' &&
      Number.isFinite(Date.parse(event.ack_until)) &&
      Date.parse(event.ack_until) > Date.parse(event.ts) &&
      Date.parse(event.ack_until) <= Date.parse(event.ts) + 86_400_000
    ) {
      previous.status = 'acknowledged';
      previous.ackUntil = event.ack_until;
    }
  }
  for (const incident of incidents.values())
    if (incident.status === 'acknowledged' && Date.parse(incident.ackUntil || '') <= now)
      incident.status = 'detected';
  return [...incidents.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
export function recordSchedulerIncident(
  scheduleId: string,
  status: 'succeeded' | 'failed',
  error?: string,
  options: SchedulerIncidentOptions = {}
): void {
  const prior = listSchedulerIncidents(options).filter(
    (incident) => incident.scheduleId === scheduleId
  );
  if (status === 'succeeded' && !prior.some((incident) => incident.status !== 'resolved')) return;
  const identity = schedulerFailureIdentity(error);
  const eventId = randomUUID().replaceAll('-', '');
  const current = prior.find(
    (incident) =>
      incident.status !== 'resolved' &&
      (status === 'succeeded' || incident.signature === identity.signature)
  );
  const episodeId = current?.episodeId || (status === 'failed' ? eventId : undefined);
  appendOpsAlertLogRecord(options.alertLogPath || defaultOpsAlertLogPath(), {
    ts: (options.now || new Date()).toISOString(),
    kind: 'scheduler_incident',
    scope: incidentScope(),
    schedule_id: scheduleId,
    ...identity,
    event: status === 'failed' ? 'failed' : 'recovered',
    event_id: eventId,
    ...(episodeId ? { episode_id: episodeId } : {}),
  });
}
/** Acknowledgement only: never enables, retries, or authorizes the job. */
export function acknowledgeSchedulerIncident(
  scheduleId: string,
  signature: string,
  episodeId: string,
  options: SchedulerIncidentOptions = {}
): boolean {
  if (typeof episodeId !== 'string' || !/^[a-f0-9]{32}$/.test(episodeId))
    throw new Error(
      '[SCHEDULER_INCIDENT_EPISODE_REQUIRED] Refresh schedules and use the observed episode id'
    );
  const incident = listSchedulerIncidents(options).find(
    (entry) =>
      entry.scheduleId === scheduleId &&
      entry.signature === signature &&
      entry.episodeId === episodeId &&
      entry.status === 'detected'
  );
  if (!incident) return false;
  const now = options.now || new Date();
  appendOpsAlertLogRecord(options.alertLogPath || defaultOpsAlertLogPath(), {
    ts: now.toISOString(),
    kind: 'scheduler_incident',
    scope: incidentScope(),
    schedule_id: scheduleId,
    signature,
    cause: incident.cause,
    event: 'acknowledged',
    event_id: randomUUID().replaceAll('-', ''),
    episode_id: episodeId,
    ack_until: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
  return true;
}

/** Shared alert dedupe must not collapse equal jobs belonging to different scopes. */
export function schedulerIncidentSweepKey(causes: string[]): string {
  return (
    'scheduler:failed-schedule-sweep:' +
    createHash('sha256')
      .update(scopeKey(incidentScope()) + '\n' + JSON.stringify([...causes].sort()))
      .digest('hex')
      .slice(0, 24)
  );
}

import type { DiscussionReadinessReport } from '@agent/core/discussion/discussion-readiness';
import type { DiscussionEngineChoice, DiscussionRunFormat } from './discussion-run-contract';

export type ReadinessProvider = DiscussionReadinessReport['provider'];
export interface ReadinessSelection {
  provider: ReadinessProvider;
  missionId: string;
}
export interface DiscussionReadinessState {
  phase: 'idle' | 'checking' | 'checked' | 'failed';
  selection: ReadinessSelection | null;
  report: DiscussionReadinessReport | null;
  failure?: 'access' | 'mission' | 'unavailable' | 'invalid';
}

const CHECK_RULES = {
  scope_checked: ['scope', 'checked'],
  tenant_required: ['scope', 'blocked'],
  adapter_declared: ['adapter', 'checked'],
  adapter_unavailable: ['adapter', 'blocked'],
  egress_allowed: ['egress_policy', 'checked'],
  egress_denied: ['egress_policy', 'blocked'],
  egress_unverified: ['egress_policy', 'unverified'],
  executable_present: ['executable', 'checked'],
  executable_missing: ['executable', 'blocked'],
  executable_inspection_unavailable: ['executable', 'unverified'],
  executable_unverified: ['executable', 'unverified'],
  artifact_parent_inspected: ['artifact_destination', 'checked'],
  artifact_directory_inspected: ['artifact_destination', 'checked'],
  artifact_unavailable: ['artifact_destination', 'blocked'],
  live_execution_unverified: ['live_execution', 'unverified'],
} as const;
const CHECK_IDS = [
  'scope',
  'adapter',
  'egress_policy',
  'executable',
  'artifact_destination',
  'live_execution',
] as const;

/** Reject incomplete, mismatched or contradictory reports; never infer live readiness. */
export function parseDiscussionReadinessReport(
  value: unknown,
  provider: ReadinessProvider
): DiscussionReadinessReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  if (
    report.provider !== provider ||
    report.execution !== 'unverified' ||
    report.provider_calls !== 0 ||
    typeof report.checked_at !== 'string' ||
    !Number.isFinite(Date.parse(report.checked_at)) ||
    !Array.isArray(report.checks) ||
    report.checks.length !== CHECK_IDS.length
  )
    return null;
  const checks: DiscussionReadinessReport['checks'] = [];
  for (const item of report.checks) {
    if (!item || typeof item !== 'object') return null;
    const check = item as Record<string, unknown>;
    if (
      typeof check.code !== 'string' ||
      !Object.prototype.hasOwnProperty.call(CHECK_RULES, check.code)
    )
      return null;
    const [id, status] = CHECK_RULES[check.code as keyof typeof CHECK_RULES];
    if (check.id !== id || check.status !== status || checks.some((entry) => entry.id === id))
      return null;
    checks.push({ id, status, code: check.code });
  }
  const checkFor = (id: DiscussionReadinessReport['checks'][number]['id']) =>
    checks.find((check) => check.id === id)!;
  const prerequisiteBlocked =
    checkFor('scope').status === 'blocked' || checkFor('adapter').status === 'blocked';
  if ((checkFor('egress_policy').status === 'unverified') !== prerequisiteBlocked) return null;
  if ((provider === 'claude') !== (checkFor('executable').code === 'executable_unverified'))
    return null;
  return {
    provider,
    checked_at: report.checked_at,
    execution: 'unverified',
    provider_calls: 0,
    checks: CHECK_IDS.map((id) => checks.find((check) => check.id === id)!),
  };
}

export function sameReadinessSelection(
  left: ReadinessSelection | null,
  right: ReadinessSelection | null
): boolean {
  return left?.provider === right?.provider && left?.missionId === right?.missionId;
}

export function canAttemptDiscussion(
  format: DiscussionRunFormat,
  engine: DiscussionEngineChoice,
  missionId: string,
  state: DiscussionReadinessState
): boolean {
  if (format !== 'brief' || engine === 'scripted') return true;
  if (
    state.phase !== 'checked' ||
    !sameReadinessSelection(state.selection, { provider: engine, missionId })
  )
    return false;
  const report = parseDiscussionReadinessReport(state.report, engine);
  return (
    report !== null &&
    report.checks.every(
      (check) =>
        check.status === 'checked' ||
        (check.status === 'unverified' &&
          (check.id === 'executable' || check.id === 'live_execution'))
    )
  );
}

export function readinessFailureForStatus(status: number): DiscussionReadinessState['failure'] {
  if (status === 401 || status === 403) return 'access';
  return status === 404 ? 'mission' : 'unavailable';
}

export interface ReadinessFetchResult {
  ok: boolean;
  status: number;
  data: { readiness?: unknown } | null;
}
export type ReadinessFetcher = (
  selection: ReadinessSelection,
  signal: AbortSignal
) => Promise<ReadinessFetchResult>;

/** One bounded check per selection. Cancellation invalidates even fetchers ignoring abort. */
export function createDiscussionReadinessController(
  fetcher: ReadinessFetcher,
  onChange: (state: DiscussionReadinessState) => void,
  options: { timeoutMs?: number } = {}
) {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : 15_000;
  let revision = 0;
  let state: DiscussionReadinessState = { phase: 'idle', selection: null, report: null };
  let active: {
    selection: ReadinessSelection;
    abort: AbortController;
    promise: Promise<void>;
    finish: () => void;
  } | null = null;
  const publish = (next: DiscussionReadinessState) => {
    state = next;
    onChange(next);
  };
  const cancel = () => {
    revision += 1;
    active?.abort.abort();
    active?.finish();
    active = null;
    state = { phase: 'idle', selection: null, report: null };
  };
  return {
    getState: () => state,
    cancel,
    invalidate(
      selection: ReadinessSelection,
      failure: DiscussionReadinessState['failure'] = 'unavailable'
    ) {
      cancel();
      publish({ phase: 'failed', selection: { ...selection }, report: null, failure });
    },
    check(selection: ReadinessSelection): Promise<void> {
      if (active && sameReadinessSelection(active.selection, selection)) return active.promise;
      cancel();
      const current = revision;
      const selected = { ...selection };
      const abort = new AbortController();
      let settle!: () => void;
      const promise = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (active?.promise === promise) active = null;
        settle();
      };
      active = { selection: selected, abort, promise, finish };
      timer = setTimeout(() => {
        if (revision !== current) return;
        revision += 1;
        abort.abort();
        publish({ phase: 'failed', selection: selected, report: null, failure: 'unavailable' });
        finish();
      }, timeoutMs);
      publish({ phase: 'checking', selection: selected, report: null });
      void Promise.resolve().then(async () => {
        if (revision !== current) return;
        try {
          const result = await fetcher(selected, abort.signal);
          if (revision !== current) return;
          const report = result.ok
            ? parseDiscussionReadinessReport(result.data?.readiness, selected.provider)
            : null;
          publish(
            report
              ? { phase: 'checked', selection: selected, report }
              : {
                  phase: 'failed',
                  selection: selected,
                  report: null,
                  failure: result.ok ? 'invalid' : readinessFailureForStatus(result.status),
                }
          );
        } catch {
          if (revision === current)
            publish({ phase: 'failed', selection: selected, report: null, failure: 'unavailable' });
        } finally {
          if (revision === current) finish();
        }
      });
      return promise;
    },
  };
}

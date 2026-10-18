'use client';

import { useEffect, useState } from 'react';
import {
  dt,
  fetchDiscussionReadiness,
  type DiscussionLocale,
  type DiscussionStringKey,
} from '../lib/discussion-client';
import {
  createDiscussionReadinessController,
  readinessFailureForStatus,
  sameReadinessSelection,
  type DiscussionReadinessState,
  type ReadinessSelection,
} from '../lib/discussion-readiness-state';

const EMPTY: DiscussionReadinessState = { phase: 'idle', selection: null, report: null };

export function useDiscussionReadiness(selection: ReadinessSelection | null) {
  const [state, setState] = useState<DiscussionReadinessState>(EMPTY);
  const [controller] = useState(() =>
    createDiscussionReadinessController(
      ({ provider, missionId }, signal) => fetchDiscussionReadiness(provider, missionId, signal),
      setState
    )
  );
  const provider = selection?.provider;
  const missionId = selection?.missionId;
  useEffect(() => {
    if (provider) void controller.check({ provider, missionId: missionId ?? '' });
    else setState(EMPTY);
    // Also invalidates a response after unmount or Strict Mode effect cleanup.
    return () => controller.cancel();
  }, [controller, provider, missionId]);
  return {
    state: sameReadinessSelection(state.selection, selection) ? state : EMPTY,
    getState: controller.getState,
    invalidate: (status: number) => {
      if (selection) controller.invalidate(selection, readinessFailureForStatus(status));
    },
    retry: () => {
      if (selection) void controller.check(selection);
    },
  };
}

const CHECK_COPY: Record<string, DiscussionStringKey> = {
  scope_checked: 'readinessScopeChecked',
  tenant_required: 'readinessTenantRequired',
  adapter_declared: 'readinessAdapterDeclared',
  adapter_unavailable: 'readinessAdapterUnavailable',
  egress_allowed: 'readinessEgressAllowed',
  egress_denied: 'readinessEgressDenied',
  egress_unverified: 'readinessEgressUnverified',
  executable_present: 'readinessExecutablePresent',
  executable_missing: 'readinessExecutableMissing',
  executable_inspection_unavailable: 'readinessExecutableInspectionUnavailable',
  executable_unverified: 'readinessExecutableUnverified',
  artifact_parent_inspected: 'readinessArtifactParentInspected',
  artifact_directory_inspected: 'readinessArtifactDirectoryInspected',
  artifact_unavailable: 'readinessArtifactUnavailable',
  live_execution_unverified: 'readinessLiveUnverified',
};
const STATUS_COPY = {
  checked: 'readinessChecked',
  blocked: 'readinessBlocked',
  unverified: 'readinessUnverified',
} as const;

/** A static preflight disclosure, never a live-ready indicator. */
export function DiscussionReadiness({
  locale,
  state,
  busy = false,
  onRetry,
}: {
  locale: DiscussionLocale;
  state: DiscussionReadinessState;
  busy?: boolean;
  onRetry: () => void;
}) {
  const checking = state.phase === 'idle' || state.phase === 'checking';
  const report = state.phase === 'checked' ? state.report : null;
  const blocked = report?.checks.some((check) => check.status === 'blocked');
  const summary = checking
    ? 'readinessChecking'
    : state.phase === 'failed'
      ? 'readinessFailed'
      : blocked
        ? 'readinessBlockers'
        : 'readinessInspected';
  return (
    <section
      id="dr-readiness"
      className="dr-note"
      role="status"
      aria-live="polite"
      aria-busy={checking}
      data-readiness={state.phase}
    >
      <strong>{dt('readinessTitle', locale)}</strong>
      <p>{dt(summary, locale)}</p>
      <p>{dt('readinessNoCalls', locale)}</p>
      <p>{dt('readinessScopeNotice', locale)}</p>
      <p>{dt('readinessLimits', locale)}</p>
      {state.phase === 'failed' ? (
        <p role="alert">
          {dt(
            state.failure === 'access'
              ? 'readinessAccessRequired'
              : state.failure === 'mission'
                ? 'readinessMissionUnavailable'
                : 'readinessRetryHint',
            locale
          )}
        </p>
      ) : null}
      {report ? (
        <ul>
          {report.checks.map((check) => (
            <li key={check.id} data-check={check.id} data-check-status={check.status}>
              <strong>{dt(STATUS_COPY[check.status], locale)}</strong>:{' '}
              {dt(CHECK_COPY[check.code] ?? 'readinessUnknownCheck', locale)}
            </li>
          ))}
        </ul>
      ) : null}
      {report && !blocked ? <p>{dt('readinessAttemptHint', locale)}</p> : null}
      <button type="button" className="dr-btn" disabled={checking || busy} onClick={onRetry}>
        {dt('readinessRetry', locale)}
      </button>
    </section>
  );
}

/** A failed create response is not proof that generation never started. */
export function DiscussionCreateUncertainty({ locale }: { locale: DiscussionLocale }) {
  return <p role="note">{dt('briefCreateUncertainty', locale)}</p>;
}

import { normalizeEventScope } from '../event/event-scope.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import { createApprovalRequest } from '../governance/approval-request-create.js';
import { loadApprovalRequest } from '../governance/approval-store-reader.js';
import { approvalUsabilityRefusal } from '../governance/approval-linked-usability.js';
import { probeSpecId } from '../pipeline/state-probe.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import { dotAdmissionScopeHash } from './dot-admission-identity.js';
import { alertProbes } from './dot-signal-scope.js';
import { dotCharterTimezone } from './dot-digest-composition.js';
import type { DotCharter } from './dot-charter.js';

function routingBinding(charter: DotCharter, signal: string) {
  const probe = charter.goal.signal_probes?.find((entry) => entry.signal === signal)?.probe;
  const policy = charter.notification.signal_alerts;
  if (
    probe?.type !== 'file' ||
    probe.expect === 'changed' ||
    !policy?.mode ||
    !charter.notification.digest_cron ||
    !alertProbes(charter).has(JSON.stringify([signal, probeSpecId(probe)]))
  )
    return undefined;
  const scope = normalizeEventScope({ ...charter.scope, nhi_id: charter.scope.owner_nhi });
  const effectBinding = recoveryEvidenceHash([
    'dot-signal-digest-preference-v1',
    dotAdmissionScopeHash(charter),
    signal,
    probeSpecId(probe),
    charter.authority.authority_role,
    charter.runtime.execution_mode ?? null,
    charter.notification.deliver_to,
    charter.notification.delivery_mode ?? null,
    dotCharterTimezone(charter) ?? null,
    charter.notification.digest_cron,
    charter.notification.quiet_hours ?? null,
    policy.max_age_s,
  ]);
  return { scope, effectBinding, correlationId: 'dot-signal-digest:' + effectBinding };
}

export function requestDotSignalRoutingReview(
  charter: DotCharter,
  signal: string,
  feedback: string,
  requester: { actorId: string; requestedBy: string }
) {
  const binding = routingBinding(charter, signal);
  const reason = feedback.trim();
  if (!binding || !reason || reason.length > 500 || charter.status !== 'active')
    throw new Error(
      '[DOT_SIGNAL_LEARNING] select an active Dot, a declared file signal and a brief reason'
    );
  return createApprovalRequest('infrastructure_sentinel', {
    ...binding,
    channel: 'terminal',
    storageChannel: AUTONOMY_APPROVAL_CHANNEL,
    threadTs: '',
    requestedBy: requester.requestedBy,
    requestedByContext: { surface: 'terminal', actorId: requester.actorId, actorRole: 'operator' },
    accountability: {
      finalDecision: 'human_only',
      effectBinding: binding.effectBinding,
      payloadHash: recoveryEvidenceHash([binding.effectBinding, reason]),
    },
    draft: {
      title: 'Review a Dot signal digest preference',
      summary: `Route future ${signal} episodes for ${charter.dot_id} to its existing digest when a fresh slot is available.`,
      details: reason,
    },
  });
}

export function hasRatifiedDigestPreference(
  charter: DotCharter,
  signal: string,
  load: typeof loadApprovalRequest = loadApprovalRequest
): boolean {
  const preference = charter.notification.signal_alerts?.ratified_digest;
  if (preference?.signal !== signal) return false;
  const binding = routingBinding(charter, signal);
  if (!binding) return false;
  try {
    const record = load(AUTONOMY_APPROVAL_CHANNEL, preference.approval_id, {
      scope: binding.scope,
    });
    return Boolean(
      record &&
      record.id === preference.approval_id &&
      record.status === 'approved' &&
      record.decidedByType === 'human' &&
      record.authenticated === true &&
      !record.veto &&
      !record.revocation &&
      record.accountability?.finalDecision === 'human_only' &&
      record.correlationId === binding.correlationId &&
      record.accountability.effectBinding === binding.effectBinding &&
      record.accountability.payloadHash ===
        recoveryEvidenceHash([binding.effectBinding, record.details]) &&
      recoveryEvidenceHash(record.scope) === recoveryEvidenceHash(binding.scope) &&
      !approvalUsabilityRefusal(record, 'dot_signal_digest_preference')
    );
  } catch {
    return false;
  }
}

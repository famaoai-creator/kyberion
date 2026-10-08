/**
 * Secret introduction façade — propose (no value) → decide → collect+apply (dual-write).
 *
 * Values never enter approval JSON, ADF, MCP, or mission prompts.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  claimApprovalApply,
  computeApprovalPayloadHash,
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  recordApprovalApplyResult,
  type ApprovalRequestRecord,
  type ApprovalRequesterContext,
  type ApprovalRiskProfile,
} from '../governance/approval-store.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { nowIso } from '../foundation/time.js';
import { ledger } from '../ledger.js';
import { withLock } from '../lock-utils.js';
import { evaluateAutonomousOpsAction } from '../governance/autonomous-ops-gate.js';
import { buildDecisionCard } from '../governance/decision-card.js';
import {
  listServiceSecretIdentities,
  parseEnvSecretName,
  resolveSecretIdentity,
  type SecretIdentity,
} from './secret-identity.js';
import { fetchSecretSync, storeSecret } from './secret-bridge.js';
import { getSecret, storeConnectionDocument } from './secret-guard.js';
import { t } from '../t.js';

const DEFAULT_CHANNEL = 'terminal';
const DEFAULT_STORAGE_CHANNEL = 'terminal';
/**
 * Decider recorded for policy auto-approvals. The policy decides, not the
 * requesting operator, so the record must never claim a human decision.
 */
export const SECRET_INTRODUCTION_AUTO_APPROVER = 'policy:secret-introduction-local-low-risk';
/** The value is collected interactively right after approval; an older pending request is abandoned. */
export const SECRET_INTRODUCTION_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface ProposeSecretIntroductionInput {
  serviceId: string;
  secretKey: string;
  reason: string;
  impactSummary?: string;
  mutation?: 'set' | 'rotate';
  riskLevel?: ApprovalRiskProfile['level'];
  channel?: string;
  storageChannel?: string;
  requestedBy?: string;
  requestedByContext?: ApprovalRequesterContext;
  /** Enable policy auto-approval only for low-risk local surfaces; never bypasses risk checks. */
  autoApproveLocal?: boolean;
  decidedBy?: string;
}

export interface ProposeSecretIntroductionResult {
  approvalId: string;
  status: ApprovalRequestRecord['status'];
  identity: SecretIdentity;
  autoApproved: boolean;
  storageChannel: string;
  channel: string;
}

/** Server-resolved authority only. Never populate this contract from request JSON. */
export interface SecretIntroductionApplyExpectation {
  principalId: string;
  serviceId: string;
  secretKey: string;
  storageChannel: 'concierge';
  channel: 'concierge';
}

/** UTF-8 byte limit for tokens collected by the Web operator surface. */
export const SECRET_INTRODUCTION_WEB_TOKEN_MAX_BYTES = 16 * 1024;
export const SECRET_INTRODUCTION_RECOVERY_REQUIRED =
  '[SECRET_INTRODUCTION] apply incomplete; recovery required before another attempt';

export interface ApplySecretIntroductionInput {
  approvalId: string;
  value: string;
  channel?: string;
  storageChannel?: string;
  appliedBy?: string;
  /** Opt in to the strict, server-bound Web operator contract. */
  expected?: SecretIntroductionApplyExpectation;
}

export interface ApplySecretIntroductionResult {
  approvalId: string;
  status: 'applied';
  identity: SecretIdentity;
  changedKeys: string[];
  connectionPath: string;
}

export interface SecretIntroductionReadiness {
  serviceId: string;
  identities: Array<{
    identity: SecretIdentity;
    present: boolean;
  }>;
  missing: string[];
}

function fingerprintValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function assertNonEmptySecret(value: string): string {
  const trimmed = String(value ?? '');
  if (!trimmed) {
    throw new Error('[SECRET_INTRODUCTION] value must not be empty');
  }
  // Reject accidental argv-style flags pasted as the secret.
  if (/^--/.test(trimmed.trim())) {
    throw new Error('[SECRET_INTRODUCTION] value must not look like a CLI flag');
  }
  return trimmed;
}

function resolveChannels(input: { channel?: string; storageChannel?: string }): {
  channel: string;
  storageChannel: string;
} {
  const channel = (input.channel || DEFAULT_CHANNEL).trim().toLowerCase() || DEFAULT_CHANNEL;
  const storageChannel =
    (input.storageChannel || channel || DEFAULT_STORAGE_CHANNEL).trim().toLowerCase() ||
    DEFAULT_STORAGE_CHANNEL;
  return { channel, storageChannel };
}

function shouldAutoApprove(input: ProposeSecretIntroductionInput): boolean {
  if (input.autoApproveLocal === false) return false;
  const risk = input.riskLevel || 'low';
  if (risk !== 'low') return false;
  const surface = input.requestedByContext?.surface;
  return surface === 'terminal' || surface === 'chronos' || surface === 'api' || !surface;
}

/**
 * Create a secret_mutation approval request without embedding the secret value.
 * For low-risk local operator sessions, auto-approve so collect/apply can proceed.
 */
export function proposeSecretIntroduction(
  input: ProposeSecretIntroductionInput
): ProposeSecretIntroductionResult {
  const identity = resolveSecretIdentity(input.serviceId, input.secretKey);
  const { channel, storageChannel } = resolveChannels(input);
  const mutation = input.mutation || 'set';
  const riskLevel = input.riskLevel || 'low';
  const requestedBy = input.requestedBy || getRegisteredEnvText('MISSION_ROLE') || 'operator';
  const correlationId = `secret-intro-${randomUUID()}`;

  const existingPresent = Boolean(
    getSecret(identity.envName) ||
    fetchSecretSync(identity.keychainService, identity.keychainAccount)
  );

  const expiresAt = new Date(Date.now() + SECRET_INTRODUCTION_PENDING_TTL_MS).toISOString();
  const reason = input.reason.trim() || 'Operator-requested secret introduction';
  const record = createApprovalRequest('mission_controller', {
    channel,
    storageChannel,
    threadTs: `${Date.now() / 1000}`,
    correlationId,
    requestedBy,
    kind: 'secret_mutation',
    expiresAt,
    draft: {
      title: `${mutation === 'rotate' ? 'Rotate' : 'Introduce'} secret: ${identity.envName}`,
      summary: `Governed introduction of ${identity.envName} for service ${identity.serviceId}.`,
      severity: riskLevel === 'critical' || riskLevel === 'high' ? 'high' : 'medium',
      details: 'Secret value is collected only after approval and never stored on this request.',
    },
    requestedByContext: input.requestedByContext || {
      surface: 'terminal',
      actorId: requestedBy,
      actorRole: 'sovereign',
      missionId: getRegisteredEnvText('MISSION_ID') || undefined,
    },
    target: {
      serviceId: identity.serviceId,
      secretKey: identity.secretKey,
      mutation,
      store: 'os_keychain',
      existingValuePresent: existingPresent,
    },
    justification: {
      reason,
      impactSummary: input.impactSummary || 'Enables service binding for the named credential.',
    },
    risk: {
      level: riskLevel,
      restartScope: 'service',
      requiresStrongAuth: riskLevel === 'high' || riskLevel === 'critical',
    },
    workflow: {
      workflowId: `wf-secret-intro-${identity.serviceId}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [{ stageId: 'stage-1', requiredRoles: ['sovereign'] }],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    source: {
      missionId: getRegisteredEnvText('MISSION_ID') || undefined,
      agentId: requestedBy,
    },
    decisionCard: buildDecisionCard({
      question: t(
        mutation === 'rotate'
          ? 'bridge:secret_card_question_rotate'
          : 'bridge:secret_card_question_set',
        { envName: identity.envName, serviceId: identity.serviceId }
      ),
      recommendation: t('bridge:secret_card_recommendation'),
      gate: evaluateAutonomousOpsAction({ actionId: 'secret_mutation' }),
      riskTier: 'approve',
      riskReasons: [reason],
      reversible: false,
      deadline: expiresAt,
    }),
  });

  let status = record.status;
  let autoApproved = false;
  if (shouldAutoApprove(input)) {
    const decided = decideApprovalRequest('mission_controller', {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: SECRET_INTRODUCTION_AUTO_APPROVER,
      decidedByRole: 'sovereign',
      decidedByType: 'service',
      authenticated: false,
      note: `Auto-approved local low-risk secret introduction (requested by ${input.decidedBy || requestedBy})`,
    });
    status = decided.status;
    autoApproved = true;
  }

  ledger.record('CONFIG_CHANGE', {
    mission_id: getRegisteredEnvText('MISSION_ID') || 'None',
    role: requestedBy,
    config_target: 'secret_introduction',
    config_scope: 'approval',
    service_id: identity.serviceId,
    changed_keys: [identity.secretKey],
    approval_id: record.id,
    auto_approved: autoApproved,
  });

  return {
    approvalId: record.id,
    status,
    identity,
    autoApproved,
    storageChannel: record.storageChannel,
    channel: record.channel,
  };
}

function assertWebExpectation(expected: SecretIntroductionApplyExpectation): SecretIdentity {
  if (
    !expected.principalId?.trim() ||
    expected.principalId !== expected.principalId.trim() ||
    expected.channel !== 'concierge' ||
    expected.storageChannel !== 'concierge'
  ) {
    throw new Error('[SECRET_INTRODUCTION] invalid server apply expectation');
  }
  const identity = resolveSecretIdentity(expected.serviceId, expected.secretKey);
  if (identity.serviceId !== expected.serviceId || identity.secretKey !== expected.secretKey) {
    throw new Error('[SECRET_INTRODUCTION] server apply identity must be canonical');
  }
  return identity;
}

function assertWebToken(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\r\n\0]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > SECRET_INTRODUCTION_WEB_TOKEN_MAX_BYTES
  ) {
    throw new Error('[SECRET_INTRODUCTION] token must be a bounded non-empty single line');
  }
}

function checkedApplyRecord(
  record: ApprovalRequestRecord | null,
  input: ApplySecretIntroductionInput,
  identity: SecretIdentity,
  channels: { channel: string; storageChannel: string }
): ApprovalRequestRecord {
  if (!record) throw new Error('[SECRET_INTRODUCTION] approval not found');
  if (record.kind !== 'secret_mutation') {
    throw new Error('[SECRET_INTRODUCTION] approval is not a secret_mutation');
  }
  if (record.applyResult?.result === 'success' || record.status === 'applied') {
    throw new Error('[SECRET_INTRODUCTION] approval was already applied');
  }
  if (record.applyClaim || record.applyResult) {
    throw new Error(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
  }
  if (record.status !== 'approved') {
    throw new Error('[SECRET_INTRODUCTION] approval must be approved before apply');
  }
  if (!record.target?.serviceId || !record.target?.secretKey) {
    throw new Error('[SECRET_INTRODUCTION] approval is missing target identity');
  }
  const target = resolveSecretIdentity(record.target.serviceId, record.target.secretKey);
  if (target.serviceId !== identity.serviceId || target.secretKey !== identity.secretKey) {
    throw new Error('[SECRET_INTRODUCTION] approval target does not match');
  }
  const expiresAt = Date.parse(record.expiresAt ?? '');
  // Existing CLI records can omit expiry, but any supplied expiry fails closed.
  if (
    (input.expected || record.expiresAt !== undefined) &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  ) {
    throw new Error('[SECRET_INTRODUCTION] approval has expired or has no valid expiry');
  }
  if (input.expected) {
    const expected = input.expected;
    if (
      channels.channel !== expected.channel ||
      channels.storageChannel !== expected.storageChannel ||
      record.channel !== expected.channel ||
      record.storageChannel !== expected.storageChannel ||
      record.requestedBy !== expected.principalId ||
      record.requestedByContext?.actorId !== expected.principalId ||
      record.target.serviceId !== expected.serviceId ||
      record.target.secretKey !== expected.secretKey ||
      (record.target.mutation !== 'set' && record.target.mutation !== 'rotate') ||
      record.target.store !== 'os_keychain' ||
      (input.appliedBy !== undefined && input.appliedBy !== expected.principalId)
    ) {
      throw new Error(
        '[SECRET_INTRODUCTION] approval does not match the server principal and target'
      );
    }
  }
  return record;
}

/**
 * Apply an approved secret introduction: dual-write keychain + connection doc.
 * The secret value is never persisted in the approval or included in errors.
 * Service locking serializes writers; the durable claim separately fences
 * replay after a process crash or a partially completed write.
 */
export async function applySecretIntroduction(
  input: ApplySecretIntroductionInput
): Promise<ApplySecretIntroductionResult> {
  const expectedIdentity = input.expected ? assertWebExpectation(input.expected) : undefined;
  if (input.expected) assertWebToken(input.value);
  const value = assertNonEmptySecret(input.value);
  const channels = resolveChannels({
    channel: input.channel ?? input.expected?.channel,
    storageChannel: input.storageChannel ?? input.expected?.storageChannel,
  });
  if (
    input.expected &&
    (channels.channel !== input.expected.channel ||
      channels.storageChannel !== input.expected.storageChannel)
  ) {
    throw new Error('[SECRET_INTRODUCTION] approval channel does not match server expectation');
  }
  const initial = expectedIdentity
    ? undefined
    : loadApprovalRequest(channels.storageChannel, input.approvalId);
  if (!expectedIdentity && (!initial?.target?.serviceId || !initial?.target?.secretKey)) {
    throw new Error('[SECRET_INTRODUCTION] approval is missing target identity');
  }
  const identity =
    expectedIdentity ??
    resolveSecretIdentity(initial!.target!.serviceId, initial!.target!.secretKey);
  return withLock('secret-introduction-service-' + identity.serviceId, async () => {
    // Read again only after obtaining the async service lock, including on CLI paths.
    const record = checkedApplyRecord(
      loadApprovalRequest(channels.storageChannel, input.approvalId),
      input,
      identity,
      channels
    );
    const appliedBy =
      input.expected?.principalId ||
      input.appliedBy ||
      getRegisteredEnvText('MISSION_ROLE') ||
      'operator';
    let claimId: string;
    try {
      claimId = claimApprovalApply('mission_controller', {
        channel: record.channel,
        storageChannel: channels.storageChannel,
        requestId: record.id,
        appliedBy,
        expectedRecordHash: computeApprovalPayloadHash({ record }),
      }).applyClaim.claimId;
    } catch {
      // A claim persistence failure may already have left the durable fence.
      throw new Error(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    }

    let stored: ReturnType<typeof storeConnectionDocument>;
    try {
      await storeSecret(identity.keychainService, identity.keychainAccount, value);
      stored = storeConnectionDocument(
        identity.serviceId,
        { [identity.connectionField]: value },
        {
          actor: 'secret_introduction',
          missionId: getRegisteredEnvText('MISSION_ID') || undefined,
        }
      );
    } catch {
      try {
        recordApprovalApplyResult('mission_controller', {
          channel: record.channel,
          storageChannel: channels.storageChannel,
          requestId: record.id,
          claimId,
          applyResult: {
            appliedAt: nowIso(),
            appliedBy,
            result: 'failed',
            auditRef: 'secret-introduction:storage-incomplete:recovery-required',
          },
        });
      } catch {
        // The persisted claim still blocks retries when even receipt storage fails.
      }
      throw new Error(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    }

    try {
      recordApprovalApplyResult('mission_controller', {
        channel: record.channel,
        storageChannel: channels.storageChannel,
        requestId: record.id,
        claimId,
        applyResult: {
          appliedAt: nowIso(),
          appliedBy,
          result: 'success',
          auditRef: 'fingerprint:' + fingerprintValue(value),
        },
      });
      ledger.record('CONFIG_CHANGE', {
        mission_id: getRegisteredEnvText('MISSION_ID') || 'None',
        role: appliedBy,
        config_target: 'secret_introduction',
        config_scope: 'apply',
        service_id: identity.serviceId,
        changed_keys: stored.changedKeys,
        approval_id: record.id,
        fingerprint: fingerprintValue(value),
      });
    } catch {
      // Both stores may now contain the value. Do not report a rollback or
      // overwrite a successful receipt merely because its audit append failed.
      throw new Error(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    }
    return {
      approvalId: record.id,
      status: 'applied',
      identity,
      changedKeys: stored.changedKeys,
      connectionPath: stored.path,
    };
  });
}

/** Report which governed suffixes are present (never returns values). */
export function describeIntroductionReadiness(serviceId: string): SecretIntroductionReadiness {
  const identities = listServiceSecretIdentities(serviceId);
  const rows = identities.map((identity) => {
    let present = false;
    try {
      present = Boolean(getSecret(identity.envName));
    } catch {
      present = false;
    }
    if (!present) {
      present = Boolean(fetchSecretSync(identity.keychainService, identity.keychainAccount));
    }
    return { identity, present };
  });
  return {
    serviceId: identities[0]?.serviceId || serviceId,
    identities: rows,
    missing: rows.filter((row) => !row.present).map((row) => row.identity.envName),
  };
}

/** Resolve identity for an env-style key used by secret-guard fallthrough. */
export function identityFromEnvKey(envName: string, scope?: string): SecretIdentity | null {
  return parseEnvSecretName(envName, scope);
}

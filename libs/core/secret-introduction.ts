/**
 * Secret introduction façade — propose (no value) → decide → collect+apply (dual-write).
 *
 * Values never enter approval JSON, ADF, MCP, or mission prompts.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  recordApprovalApplyResult,
  type ApprovalRequestRecord,
  type ApprovalRequesterContext,
  type ApprovalRiskProfile,
} from './approval-store.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { ledger } from './ledger.js';
import {
  listServiceSecretIdentities,
  parseEnvSecretName,
  resolveSecretIdentity,
  type SecretIdentity,
} from './secret-identity.js';
import { fetchSecretSync, storeSecret } from './secret-bridge.js';
import { getSecret, storeConnectionDocument } from './secret-guard.js';

const DEFAULT_CHANNEL = 'terminal';
const DEFAULT_STORAGE_CHANNEL = 'terminal';

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
  /** When true (default for risk=low + terminal/concierge surface), auto-approve after create. */
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

export interface ApplySecretIntroductionInput {
  approvalId: string;
  value: string;
  channel?: string;
  storageChannel?: string;
  appliedBy?: string;
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
  if (input.autoApproveLocal === true) return true;
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

  const record = createApprovalRequest('mission_controller', {
    channel,
    storageChannel,
    threadTs: `${Date.now() / 1000}`,
    correlationId,
    requestedBy,
    kind: 'secret_mutation',
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
      reason: input.reason.trim() || 'Operator-requested secret introduction',
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
  });

  let status = record.status;
  let autoApproved = false;
  if (shouldAutoApprove(input)) {
    const decided = decideApprovalRequest('mission_controller', {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: input.decidedBy || requestedBy,
      decidedByRole: 'sovereign',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      note: 'Auto-approved local low-risk secret introduction',
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

/**
 * Apply an approved secret introduction: dual-write keychain + connection doc.
 * The secret value must be supplied by the collector; it is never read from the approval record.
 */
export async function applySecretIntroduction(
  input: ApplySecretIntroductionInput
): Promise<ApplySecretIntroductionResult> {
  const value = assertNonEmptySecret(input.value);
  const { channel, storageChannel } = resolveChannels(input);
  const record = loadApprovalRequest(storageChannel, input.approvalId);
  if (!record) {
    throw new Error(`[SECRET_INTRODUCTION] approval not found: ${input.approvalId}`);
  }
  if (record.kind !== 'secret_mutation') {
    throw new Error(`[SECRET_INTRODUCTION] approval ${input.approvalId} is not a secret_mutation`);
  }
  if (record.status !== 'approved') {
    throw new Error(
      `[SECRET_INTRODUCTION] approval ${input.approvalId} is ${record.status}; must be approved before apply`
    );
  }
  if (!record.target?.serviceId || !record.target?.secretKey) {
    throw new Error(
      `[SECRET_INTRODUCTION] approval ${input.approvalId} is missing target identity`
    );
  }
  if (record.applyResult?.result === 'success') {
    throw new Error(`[SECRET_INTRODUCTION] approval ${input.approvalId} was already applied`);
  }

  const identity = resolveSecretIdentity(record.target.serviceId, record.target.secretKey);
  const appliedBy = input.appliedBy || getRegisteredEnvText('MISSION_ROLE') || 'operator';

  try {
    await storeSecret(identity.keychainService, identity.keychainAccount, value);
    const stored = storeConnectionDocument(
      identity.serviceId,
      { [identity.connectionField]: value },
      {
        actor: 'secret_introduction',
        missionId: getRegisteredEnvText('MISSION_ID') || undefined,
      }
    );

    recordApprovalApplyResult('mission_controller', {
      channel: record.channel || channel,
      storageChannel: record.storageChannel || storageChannel,
      requestId: record.id,
      applyResult: {
        appliedAt: nowIso(),
        appliedBy,
        result: 'success',
        auditRef: `fingerprint:${fingerprintValue(value)}`,
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

    return {
      approvalId: record.id,
      status: 'applied',
      identity,
      changedKeys: stored.changedKeys,
      connectionPath: stored.path,
    };
  } catch (error) {
    recordApprovalApplyResult('mission_controller', {
      channel: record.channel || channel,
      storageChannel: record.storageChannel || storageChannel,
      requestId: record.id,
      applyResult: {
        appliedAt: nowIso(),
        appliedBy,
        result: 'failed',
        auditRef: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
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

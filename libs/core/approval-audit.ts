import { auditChain, type AuditEntry } from './audit-chain.js';

export interface ApprovalAuditTrailEntry {
  id: string;
  timestamp: string;
  agentId: string;
  operation: string;
  result: AuditEntry['result'];
  reason: string | null;
  correlationId: string | null;
  intentId: string | null;
  decisionType: string | null;
  decisionRightsSource: string | null;
}

export interface ApprovalAuditTrailSummary {
  total: number;
  allowed: number;
  denied: number;
  pending: number;
  recent: ApprovalAuditTrailEntry[];
}

export interface ApprovalAuditDecisionBreakdown {
  decisionType: string;
  total: number;
  allowed: number;
  denied: number;
  pending: number;
  latestCorrelationId: string | null;
  latestTimestamp: string | null;
}

export interface ApprovalAuditCorrelationBreakdown {
  correlationId: string;
  total: number;
  allowed: number;
  denied: number;
  pending: number;
  decisionTypes: string[];
  latestDecisionType: string | null;
  latestOperation: string | null;
  latestTimestamp: string | null;
  recent: ApprovalAuditTrailEntry[];
}

export interface ApprovalAuditDrilldownSummary extends ApprovalAuditTrailSummary {
  byDecisionType: ApprovalAuditDecisionBreakdown[];
  byCorrelationId: ApprovalAuditCorrelationBreakdown[];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function countByResult(entries: ApprovalAuditTrailEntry[]) {
  return {
    total: entries.length,
    allowed: entries.filter((entry) => entry.result === 'allowed').length,
    denied: entries.filter((entry) => entry.result === 'denied').length,
    pending: entries.filter((entry) => entry.result === 'completed' || entry.result === 'error')
      .length,
  };
}

export function listApprovalAuditTrail(limit = 12): ApprovalAuditTrailEntry[] {
  return auditChain
    .loadAll()
    .filter((entry) => entry.action === 'approval_gate')
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      agentId: entry.agentId,
      operation: entry.operation,
      result: entry.result,
      reason: toStringOrNull(entry.reason),
      correlationId: toStringOrNull(entry.metadata?.correlationId),
      intentId: toStringOrNull(entry.metadata?.intentId),
      decisionType: toStringOrNull(entry.metadata?.decisionType),
      decisionRightsSource: toStringOrNull(entry.metadata?.decisionRightsSource),
    }))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);
}

export function summarizeApprovalAuditTrail(limit = 12): ApprovalAuditTrailSummary {
  const recent = listApprovalAuditTrail(limit);
  const all = auditChain.loadAll().filter((entry) => entry.action === 'approval_gate');
  const counts = countByResult(
    all.map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      agentId: entry.agentId,
      operation: entry.operation,
      result: entry.result,
      reason: toStringOrNull(entry.reason),
      correlationId: toStringOrNull(entry.metadata?.correlationId),
      intentId: toStringOrNull(entry.metadata?.intentId),
      decisionType: toStringOrNull(entry.metadata?.decisionType),
      decisionRightsSource: toStringOrNull(entry.metadata?.decisionRightsSource),
    }))
  );
  return {
    total: counts.total,
    allowed: counts.allowed,
    denied: counts.denied,
    pending: counts.pending,
    recent,
  };
}

export function summarizeApprovalAuditDrilldown(limit = 12): ApprovalAuditDrilldownSummary {
  const recent = listApprovalAuditTrail(limit);
  const all = auditChain
    .loadAll()
    .filter((entry) => entry.action === 'approval_gate')
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      agentId: entry.agentId,
      operation: entry.operation,
      result: entry.result,
      reason: toStringOrNull(entry.reason),
      correlationId: toStringOrNull(entry.metadata?.correlationId),
      intentId: toStringOrNull(entry.metadata?.intentId),
      decisionType: toStringOrNull(entry.metadata?.decisionType),
      decisionRightsSource: toStringOrNull(entry.metadata?.decisionRightsSource),
    }));
  const counts = countByResult(all);

  const decisionTypeMap = new Map<
    string,
    {
      total: number;
      allowed: number;
      denied: number;
      pending: number;
      latestCorrelationId: string | null;
      latestTimestamp: string | null;
    }
  >();
  const correlationMap = new Map<
    string,
    {
      total: number;
      allowed: number;
      denied: number;
      pending: number;
      decisionTypes: Set<string>;
      latestDecisionType: string | null;
      latestOperation: string | null;
      latestTimestamp: string | null;
      recent: ApprovalAuditTrailEntry[];
    }
  >();

  for (const entry of all) {
    const decisionType = entry.decisionType || 'unknown';
    const decisionBucket = decisionTypeMap.get(decisionType) || {
      total: 0,
      allowed: 0,
      denied: 0,
      pending: 0,
      latestCorrelationId: null,
      latestTimestamp: null,
    };
    decisionBucket.total += 1;
    if (entry.result === 'allowed') decisionBucket.allowed += 1;
    if (entry.result === 'denied') decisionBucket.denied += 1;
    if (entry.result === 'completed' || entry.result === 'error') decisionBucket.pending += 1;
    if (!decisionBucket.latestTimestamp || entry.timestamp > decisionBucket.latestTimestamp) {
      decisionBucket.latestTimestamp = entry.timestamp;
      decisionBucket.latestCorrelationId = entry.correlationId;
    }
    decisionTypeMap.set(decisionType, decisionBucket);

    if (!entry.correlationId) continue;
    const correlationBucket = correlationMap.get(entry.correlationId) || {
      total: 0,
      allowed: 0,
      denied: 0,
      pending: 0,
      decisionTypes: new Set<string>(),
      latestDecisionType: null,
      latestOperation: null,
      latestTimestamp: null,
      recent: [],
    };
    correlationBucket.total += 1;
    if (entry.result === 'allowed') correlationBucket.allowed += 1;
    if (entry.result === 'denied') correlationBucket.denied += 1;
    if (entry.result === 'completed' || entry.result === 'error') correlationBucket.pending += 1;
    if (entry.decisionType) correlationBucket.decisionTypes.add(entry.decisionType);
    if (!correlationBucket.latestTimestamp || entry.timestamp > correlationBucket.latestTimestamp) {
      correlationBucket.latestTimestamp = entry.timestamp;
      correlationBucket.latestDecisionType = entry.decisionType;
      correlationBucket.latestOperation = entry.operation;
    }
    correlationBucket.recent.push(entry);
    correlationMap.set(entry.correlationId, correlationBucket);
  }

  return {
    total: counts.total,
    allowed: counts.allowed,
    denied: counts.denied,
    pending: counts.pending,
    recent,
    byDecisionType: [...decisionTypeMap.entries()]
      .map(([decisionType, bucket]) => ({
        decisionType,
        ...bucket,
      }))
      .sort(
        (left, right) =>
          right.total - left.total ||
          (right.latestTimestamp || '').localeCompare(left.latestTimestamp || '')
      )
      .slice(0, limit),
    byCorrelationId: [...correlationMap.entries()]
      .map(([correlationId, bucket]) => ({
        correlationId,
        ...bucket,
        decisionTypes: [...bucket.decisionTypes].sort(),
        recent: bucket.recent
          .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
          .slice(0, 5),
      }))
      .sort(
        (left, right) =>
          right.total - left.total ||
          (right.latestTimestamp || '').localeCompare(left.latestTimestamp || '')
      )
      .slice(0, limit),
  };
}

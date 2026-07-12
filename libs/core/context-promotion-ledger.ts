import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { safeAppendFileSync, safeMkdir } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type { TierLevel } from './types.js';
import type { ContextSecurityScope } from './context-security-scope.js';

const TIER_SENSITIVITY: Record<TierLevel, number> = {
  public: 1,
  confidential: 3,
  personal: 4,
};

export interface ContextPromotionAuthorization {
  authorization_id: string;
  source_tier: TierLevel;
  target_tier: TierLevel;
  tenant_id: string;
  project_id?: string;
  mission_id: string;
  purpose: string;
  approved_by: string;
  approved_at: string;
  expires_at: string;
  reason: string;
  content_digest: string;
}

export interface RecordContextPromotionInput {
  source_tier: TierLevel;
  target_tier: TierLevel;
  security_scope: ContextSecurityScope;
  approved_by: string;
  approved_at?: string;
  expires_at: string;
  reason: string;
  content: string;
  ledger_path?: string;
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function requireText(label: string, value: string | undefined): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`[CONTEXT_PROMOTION_INVALID] ${label} is required`);
  return normalized;
}

export function recordContextPromotion(
  input: RecordContextPromotionInput
): ContextPromotionAuthorization {
  if (TIER_SENSITIVITY[input.target_tier] >= TIER_SENSITIVITY[input.source_tier]) {
    throw new Error('[CONTEXT_PROMOTION_INVALID] promotion must target a less sensitive tier');
  }
  const approvedAt = input.approved_at || new Date().toISOString();
  const expiresAt = requireText('expires_at', input.expires_at);
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) {
    throw new Error('[CONTEXT_PROMOTION_INVALID] expires_at must be after approved_at');
  }
  const approvedBy = requireText('approved_by', input.approved_by);
  const reason = requireText('reason', input.reason);
  const contentDigest = digest(input.content);
  const authorizationId = `CPA-${contentDigest.slice(0, 12).toUpperCase()}-${Date.parse(approvedAt)}`;
  const authorization: ContextPromotionAuthorization = {
    authorization_id: authorizationId,
    source_tier: input.source_tier,
    target_tier: input.target_tier,
    tenant_id: input.security_scope.tenant_id,
    ...(input.security_scope.project_id ? { project_id: input.security_scope.project_id } : {}),
    mission_id: input.security_scope.mission_id,
    purpose: input.security_scope.purpose,
    approved_by: approvedBy,
    approved_at: approvedAt,
    expires_at: expiresAt,
    reason,
    content_digest: contentDigest,
  };
  const ledgerPath =
    input.ledger_path || pathResolver.active('shared/audit/context-promotion-ledger.jsonl');
  safeMkdir(path.dirname(ledgerPath), { recursive: true });
  safeAppendFileSync(ledgerPath, `${JSON.stringify(authorization)}\n`);
  return authorization;
}

export function validateContextPromotion(input: {
  authorization: ContextPromotionAuthorization;
  source_tier: TierLevel;
  target_tier: TierLevel;
  security_scope: ContextSecurityScope;
  content: string;
  now?: string;
}): { allowed: boolean; reason?: string } {
  const authorization = input.authorization;
  const expected = {
    source_tier: input.source_tier,
    target_tier: input.target_tier,
    tenant_id: input.security_scope.tenant_id,
    project_id: input.security_scope.project_id,
    mission_id: input.security_scope.mission_id,
    purpose: input.security_scope.purpose,
    content_digest: digest(input.content),
  };
  for (const [field, value] of Object.entries(expected)) {
    if ((authorization as any)[field] !== value) {
      return { allowed: false, reason: `[CONTEXT_PROMOTION_MISMATCH] ${field}` };
    }
  }
  if (Date.parse(authorization.expires_at) <= Date.parse(input.now || new Date().toISOString())) {
    return { allowed: false, reason: '[CONTEXT_PROMOTION_EXPIRED]' };
  }
  return { allowed: true };
}

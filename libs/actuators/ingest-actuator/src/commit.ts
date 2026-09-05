/**
 * DA-05 ingest:commit — the explicit ingest ceremony (案7 Hybrid Sovereign
 * Ledger). This is the ONLY ingest-actuator op that writes into
 * knowledge/confidential/: it lands the DA-04 normalize_card output and
 * appends the information-asset ledger record in the same call, so every
 * card under a tenant knowledge root has who/when/why/visible-to lineage.
 * There is deliberately no auto-ingest path (案6 Sovereign Funnel stays
 * rejected) — a human/agent invokes this ceremony per document.
 *
 * Fail-closed guards, in order:
 *   1. path guard + tier gate — target_path must resolve INSIDE the tenant's
 *      knowledge_root. Absolute paths, '..' escapes, and other tenants'
 *      prefixes are rejected before anything is touched. DA-06: landing in
 *      knowledge/confidential/common/ or knowledge/public/ingest/ (the only
 *      public subtree this ceremony may touch) additionally requires a
 *      steward_approval_id verified against the KM-03 promotion queue —
 *      auto-promotion toward lower tiers is structurally impossible.
 *   2. duplicate — a dedup_result.duplicate commits nothing.
 *   3. identity — ingested_by must be resolvable (explicit input, or
 *      KYBERION_PERSONA / MISSION_ROLE); anonymous ingests are refused.
 *   4. PII・秘匿ガード (DA-06) — the normalized card (frontmatter + body) is
 *      scanned against knowledge-sync-rules.json pii_patterns BEFORE any
 *      write: block-action findings refuse the commit (structured error with
 *      rule ids, never raw matches) unless an audited operator override
 *      downgrades the listed rules to mask; mask-action findings land as
 *      [REDACTED:{rule_id}] with a 'pii_scrub:{ids}' transform_chain entry.
 *      The body also passes the SA-03 injection scan — suspected content is
 *      wrapped in the untrusted-content banner ('untrusted_wrap' entry).
 *
 * Writes run under the narrowly-scoped `ingest_commit` authority role
 * (security-policy.json authority_role_permissions.ingest_commit — the LE-03
 * reconcile_config_fallbacks pattern): the ceremony body is the only code
 * that enters that execution context.
 */

import * as path from 'node:path';
import {
  appendAssetRecord,
  assetProvenanceRef,
  COMMON_TENANT_SLUG,
  deriveAssetId,
  findAssetBySource,
  tenantIngestKnowledgeRoot,
  type IngestAssetRecord,
} from '@agent/core/ingest-asset-ledger';
import { logger } from '@agent/core/core';
import {
  checkIngestQuota,
  recordIngestUsage,
  shouldEnforceIngestQuota,
} from '@agent/core/ingest-quota';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { scanForInjection, wrapUntrusted } from '@agent/core/untrusted-content';
import { scrubContent } from '@agent/core/pii-scrubber';
import { updateMemoryPromotionCandidateStatus } from '@agent/core/memory-promotion-queue';
import { verifyStewardApproval } from '@agent/core/ingest-tier-gate';
import { withExecutionContext } from '@agent/core/authority';
import type { IngestLedgerPathOptions } from '@agent/core/ingest-asset-ledger';
import type { IngestQuotaCheck, IngestQuotaLevel } from '@agent/core/ingest-quota';
import type { MemoryCandidate } from '@agent/core/memory-promotion-queue';
import type { PiiScrubApplication } from '@agent/core/pii-scrubber';
import type { TierPromotionTargetRoot } from '@agent/core/ingest-tier-gate';
import { auditChain } from '@agent/core/audit-chain';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import type { DedupResult, IngestRegistryRecord } from './dedup.js';
import type { NormalizeCardResult } from './normalize-card.js';
import type { IngestSourceMeta } from './parse-document.js';

/** Authority role the ceremony executes under (security-policy.json). */
export const INGEST_COMMIT_ROLE = 'ingest_commit';

/**
 * DA-06: the ONLY public subtree the ceremony can land in (with steward
 * approval). Matches the ingest_commit allow_write grant in
 * security-policy.json — keep the two in sync.
 */
export const PUBLIC_INGEST_ROOT = 'knowledge/public/ingest';

const SHA256_RE = /^[a-f0-9]{64}$/;

/** DA-06 operator override: downgrade listed block rules to mask (audited). */
export interface IngestScrubOverride {
  rule_ids: string[];
  reason: string;
  approved_by: string;
}

export interface IngestCommitInput {
  tenant_slug: string;
  /** DA-04 ingest:normalize_card output. */
  normalized: NormalizeCardResult;
  /** DA-04 ingest:dedup output — duplicate short-circuits, supersedes_candidate informs supersede. */
  dedup_result?: DedupResult;
  /** Source provenance; content_sha256 may ride here or in the normalized frontmatter. */
  source_meta?: IngestSourceMeta & { content_sha256?: string };
  approval_id?: string;
  /**
   * DA-06: KM-03 promotion-queue candidate id ('approved' by a steward) —
   * REQUIRED for any landing in knowledge/confidential/common/ or
   * knowledge/public/ingest/. Tenant-root landings never need it.
   */
  steward_approval_id?: string;
  /** DA-06: false-positive override — block-action rules listed here are masked instead (audited). */
  override?: IngestScrubOverride;
  /** Defaults to KYBERION_PERSONA, then MISSION_ROLE. Refused when unresolvable. */
  ingested_by?: string;
  /** Recorded verbatim; defaults to ['normalize_card'] (the input is a normalize_card output). */
  transform_chain?: string[];
  /** Defaults to [tenant_slug]. */
  visible_to?: string[];
  /** Explicit ingested_at timestamp (test determinism). Default: wall clock. */
  now?: string;
  /** Test seam: fixture tenant-registry/ledger roots. */
  path_options?: IngestLedgerPathOptions;
}

export interface IngestCommitResult {
  committed: boolean;
  reason?: 'duplicate';
  existing?: IngestRegistryRecord;
  asset?: IngestAssetRecord;
  /** KKP provenance ref (asset:{id}@v{n}) when committed. */
  provenance_ref?: string;
  target_path?: string;
  absolute_path?: string;
  /** DA-06: rule ids whose matches were masked in the landed card. */
  pii_scrub_applied?: string[];
  /** DA-06/SA-03: true when the body was wrapped in the untrusted-content banner. */
  untrusted_wrap?: boolean;
  /** DA-08: quota level at commit time ('ok' | 'warn') when enforcement ran. */
  quota_level?: IngestQuotaLevel;
}

function fail(message: string): never {
  throw new Error(`ingest:commit — ${message}`);
}

/**
 * Fail-closed path guard: the repo-relative target must stay inside the
 * tenant's knowledge root. Rejects absolute paths, drive letters, '..'
 * segments and any prefix escape (including other tenants), then re-checks
 * the RESOLVED absolute path (defense in depth against normalization
 * surprises).
 */
export function assertTargetInsideTenantRoot(
  targetPath: string,
  knowledgeRoot: string,
  rootDir: string
): string {
  if (!targetPath || typeof targetPath !== 'string') {
    fail('normalized.target_path is required');
  }
  if (path.isAbsolute(targetPath) || /^[A-Za-z]:/.test(targetPath)) {
    fail(`target_path must be repo-relative, got absolute: ${targetPath}`);
  }
  const segments = targetPath.split(/[\\/]/);
  if (segments.some((segment) => segment === '..' || segment === '')) {
    fail(`target_path must not contain '..' or empty segments: ${targetPath}`);
  }
  const normalizedTarget = segments.join('/');
  if (normalizedTarget !== knowledgeRoot && !normalizedTarget.startsWith(`${knowledgeRoot}/`)) {
    fail(
      `target_path '${targetPath}' is outside the tenant knowledge root '${knowledgeRoot}' — ` +
        'the ingest ceremony only lands cards inside the declared tenant namespace'
    );
  }
  const absRoot = path.resolve(rootDir, knowledgeRoot);
  const absTarget = path.resolve(rootDir, normalizedTarget);
  if (absTarget !== absRoot && !absTarget.startsWith(absRoot + path.sep)) {
    fail(`resolved target '${absTarget}' escapes the tenant knowledge root '${absRoot}'`);
  }
  assertSafeRepositoryPath(absRoot, { allowMissingLeaf: true });
  return assertSafeRepositoryPath(absTarget, { allowMissingLeaf: true });
}

function resolveIngestedBy(input: IngestCommitInput): string {
  const explicit = String(input.ingested_by || '').trim();
  if (explicit) return explicit;
  const persona = String(getRegisteredEnvText('KYBERION_PERSONA') || '').trim();
  if (persona) return persona;
  const role = String(getRegisteredEnvText('MISSION_ROLE') || '').trim();
  if (role) return role;
  fail(
    'ingested_by is required and no identity context is active — pass ingested_by explicitly ' +
      'or run with KYBERION_PERSONA / MISSION_ROLE set (explicit ingest ceremony, no anonymous ingest)'
  );
}

function frontmatterString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sortCodepoint(values: string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Validate the DA-06 override shape — unexplained or anonymous overrides are refused. */
function normalizeOverride(raw: IngestCommitInput['override']): IngestScrubOverride | null {
  if (raw === undefined || raw === null) return null;
  const ruleIds = Array.isArray(raw.rule_ids)
    ? raw.rule_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const reason = String(raw.reason || '').trim();
  const approvedBy = String(raw.approved_by || '').trim();
  if (ruleIds.length === 0 || !reason || !approvedBy) {
    fail(
      'override requires non-empty rule_ids, reason and approved_by — ' +
        'anonymous or unexplained scrub overrides are refused'
    );
  }
  return { rule_ids: sortCodepoint([...new Set(ruleIds)]), reason, approved_by: approvedBy };
}

/**
 * DA-06: steward-approval requirement for any landing outside the owning
 * tenant's root. No id → fail closed; the id itself is verified against the
 * KM-03 promotion queue (must be a tier-promotion candidate for the SAME
 * target root, ratified by a steward).
 */
function requireStewardApproval(
  targetRoot: TierPromotionTargetRoot,
  approvalId: string | undefined,
  targetPath: string
): MemoryCandidate {
  const id = String(approvalId || '').trim();
  if (!id) {
    fail(
      `target '${targetPath}' lands under '${targetRoot}' — landing outside the owning tenant root ` +
        'requires steward_approval_id from the KM-03 promotion queue ' +
        '(enqueueTierPromotionCandidate → steward approves → the candidate id feeds this input). ' +
        'Auto-promotion toward lower tiers is not possible.'
    );
  }
  return verifyStewardApproval({ approval_id: id, target_root: targetRoot });
}

interface ScrubbedCardParts {
  /** Scrubbed frontmatter block, or null when the card shape is not fm+body. */
  frontmatter_block: string | null;
  /** Scrubbed body (or the whole scrubbed card when frontmatter_block is null). */
  body: string;
  blocked: boolean;
  block_reasons: string[];
  applied: PiiScrubApplication[];
}

function mergeApplied(
  left: PiiScrubApplication[],
  right: PiiScrubApplication[]
): PiiScrubApplication[] {
  const byRule = new Map<string, PiiScrubApplication>();
  for (const entry of [...left, ...right]) {
    const current = byRule.get(entry.rule_id);
    byRule.set(
      entry.rule_id,
      current
        ? {
            rule_id: entry.rule_id,
            count: current.count + entry.count,
            overridden: current.overridden || entry.overridden,
          }
        : entry
    );
  }
  return [...byRule.values()].sort((a, b) =>
    a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0
  );
}

/**
 * Scrub the card. normalize_card serializes card_markdown as
 * `${frontmatter}\n\n${body}\n`, so frontmatter and body are scrubbed
 * separately (the SA-03 wrap must go around the BODY only — a banner above
 * the frontmatter would break the knowledge-card format). Callers that pass
 * a hand-built card fall back to whole-card scrubbing.
 */
function scrubCardParts(normalized: NormalizeCardResult, overrideIds: string[]): ScrubbedCardParts {
  const options = { override_rule_ids: overrideIds };
  const body = typeof normalized.body_markdown === 'string' ? normalized.body_markdown : null;
  const suffix = body === null ? null : `\n\n${body}\n`;
  if (suffix !== null && body !== null && normalized.card_markdown.endsWith(suffix)) {
    const frontmatterBlock = normalized.card_markdown.slice(
      0,
      normalized.card_markdown.length - suffix.length
    );
    const fmScrub = scrubContent(frontmatterBlock, options);
    const bodyScrub = scrubContent(body, options);
    return {
      frontmatter_block: fmScrub.scrubbed_text,
      body: bodyScrub.scrubbed_text,
      blocked: fmScrub.blocked || bodyScrub.blocked,
      block_reasons: sortCodepoint([
        ...new Set([...fmScrub.block_reasons, ...bodyScrub.block_reasons]),
      ]),
      applied: mergeApplied(fmScrub.applied, bodyScrub.applied),
    };
  }
  const cardScrub = scrubContent(normalized.card_markdown, options);
  return {
    frontmatter_block: null,
    body: cardScrub.scrubbed_text,
    blocked: cardScrub.blocked,
    block_reasons: cardScrub.block_reasons,
    applied: cardScrub.applied,
  };
}

/**
 * The DA-05 explicit ingest ceremony. See the module doc for guard order.
 * Returns { committed: false, reason: 'duplicate' } for exact re-ingests and
 * a SUPERSEDE (same target_path, version+1, supersedes ref) when the same
 * source arrives with new content.
 */
export function commitIngest(input: IngestCommitInput): IngestCommitResult {
  const tenantSlug = String(input?.tenant_slug || '').trim();
  if (!tenantSlug) fail('tenant_slug is required');
  const normalized = input?.normalized;
  if (
    !normalized ||
    typeof normalized.target_path !== 'string' ||
    typeof normalized.card_markdown !== 'string' ||
    !normalized.frontmatter ||
    typeof normalized.frontmatter !== 'object'
  ) {
    fail(
      'normalized must be an ingest:normalize_card result (target_path, frontmatter, card_markdown)'
    );
  }

  const pathOptions = input.path_options ?? {};
  const rootDir = pathOptions.rootDir ?? pathResolver.rootDir();

  // (a) fail-closed path guard + DA-06 tier gate, before anything else.
  // Landing class: tenant root (unchanged DA-05 behavior), or — ONLY with a
  // verified KM-03 steward approval — knowledge/confidential/common/ or the
  // knowledge/public/ingest/ subtree.
  const normalizedTargetPath = String(normalized.target_path || '')
    .split(/[\\/]/)
    .join('/');
  const isPublicTarget =
    normalizedTargetPath === 'knowledge/public' ||
    normalizedTargetPath.startsWith('knowledge/public/');
  let knowledgeRoot: string;
  let stewardApproval: MemoryCandidate | null = null;
  if (isPublicTarget) {
    stewardApproval = requireStewardApproval(
      'knowledge/public',
      input.steward_approval_id,
      normalized.target_path
    );
    knowledgeRoot = PUBLIC_INGEST_ROOT;
    // The ledger still lives under the (registered) tenant root — resolve it
    // so an unregistered tenant fails closed here too.
    tenantIngestKnowledgeRoot(tenantSlug, pathOptions);
  } else {
    // Resolves via resolveTenant — an unregistered tenant fails closed here.
    knowledgeRoot = tenantIngestKnowledgeRoot(tenantSlug, pathOptions);
    if (tenantSlug === COMMON_TENANT_SLUG) {
      stewardApproval = requireStewardApproval(
        'knowledge/confidential/common',
        input.steward_approval_id,
        normalized.target_path
      );
    }
  }
  const absTarget = assertTargetInsideTenantRoot(normalized.target_path, knowledgeRoot, rootDir);

  // (b) exact duplicate → no write.
  if (input.dedup_result?.duplicate) {
    return {
      committed: false,
      reason: 'duplicate',
      ...(input.dedup_result.existing ? { existing: input.dedup_result.existing } : {}),
      target_path: normalized.target_path,
    };
  }

  // (c) identity + provenance requirements — explicit over implicit.
  const ingestedBy = resolveIngestedBy(input);
  const frontmatter = normalized.frontmatter as Record<string, unknown>;
  const sourceSystem =
    String(input.source_meta?.source_system || '').trim() ||
    frontmatterString(frontmatter, 'source_system');
  const sourceId =
    String(input.source_meta?.source_id || '').trim() ||
    frontmatterString(frontmatter, 'source_id');
  if (!sourceSystem || !sourceId) {
    fail(
      'source_system and source_id are required (via source_meta or the normalized frontmatter) — ' +
        'the asset ledger needs a stable source identity'
    );
  }
  const contentSha256 =
    String(input.source_meta?.content_sha256 || '').trim() ||
    frontmatterString(frontmatter, 'content_sha256');
  if (!contentSha256 || !SHA256_RE.test(contentSha256)) {
    fail('content_sha256 (sha256 hex) is required via source_meta or the normalized frontmatter');
  }

  // (c1.5) DA-08 取込クォータ — staged warn→block budget gate, BEFORE the
  // PII gate and before anything is written. Bytes are measured on the
  // normalized card (the same measure recorded after a successful landing).
  // warn: log + proceed, noted in the commit audit record; block: refuse
  // with a structured error and a denied audit record. Usage is recorded
  // only after a successful commit — refused ceremonies consume no quota.
  const quotaNow = String(input.now || '').trim() || undefined;
  const cardBytes = Buffer.byteLength(normalized.card_markdown, 'utf8');
  const quota: IngestQuotaCheck | null = shouldEnforceIngestQuota()
    ? checkIngestQuota(tenantSlug, { bytes: cardBytes, files: 1 }, { rootDir, now: quotaNow })
    : null;
  if (quota && !quota.allowed) {
    auditChain.record({
      agentId: 'ingest-actuator',
      action: 'ingest.commit',
      operation: normalized.target_path,
      result: 'denied',
      reason:
        `Ingest quota exceeded (${quota.exceeded.join(', ')}) for tenant '${tenantSlug}' on ${quota.date}: ` +
        `files ${quota.projected.files}/${quota.limit.max_files_per_day}, ` +
        `bytes ${quota.projected.bytes}/${quota.limit.max_bytes_per_day}.`,
      tenantSlug,
      metadata: {
        quota_level: quota.level,
        quota_exceeded: quota.exceeded,
        quota_usage: quota.usage,
        quota_projected: quota.projected,
        quota_limit: quota.limit,
        source_system: sourceSystem,
        source_id: sourceId,
      },
    });
    fail(
      `blocked by the ingest quota (${quota.exceeded.join(', ')}): tenant '${tenantSlug}' would exceed ` +
        `its daily limit (files ${quota.projected.files}/${quota.limit.max_files_per_day}, ` +
        `bytes ${quota.projected.bytes}/${quota.limit.max_bytes_per_day}) — nothing was written. ` +
        'Raise the limit in knowledge/product/governance/ingest-quota-policy.json or retry tomorrow.'
    );
  }

  // (c2) DA-06 PII・秘匿ガード — scrub BEFORE anything is written. Block-action
  // findings refuse the whole ceremony unless the operator override lists
  // them; the refusal (and every override) is audit-logged with rule ids
  // only — raw matches never leave the scrubber.
  const override = normalizeOverride(input.override);
  const scrub = scrubCardParts(normalized, override?.rule_ids ?? []);
  if (scrub.blocked) {
    auditChain.record({
      agentId: 'ingest-actuator',
      action: 'ingest.commit',
      operation: normalized.target_path,
      result: 'denied',
      reason:
        `PII/secret gate blocked the commit: [${scrub.block_reasons.join(', ')}] ` +
        '(rule ids only — raw matches are never recorded).',
      tenantSlug,
      metadata: {
        blocked_rule_ids: scrub.block_reasons,
        override_present: Boolean(override),
        source_system: sourceSystem,
        source_id: sourceId,
      },
    });
    fail(
      `blocked by the PII/secret gate: [${scrub.block_reasons.join(', ')}] — nothing was written. ` +
        'If these are false positives, re-run with override { rule_ids, reason, approved_by } ' +
        '(the override is audit-logged).'
    );
  }
  if (override) {
    auditChain.record({
      agentId: 'ingest-actuator',
      action: 'ingest.commit.scrub_override',
      operation: normalized.target_path,
      result: 'completed',
      reason: `Operator override downgraded block→mask for [${override.rule_ids.join(', ')}]: ${override.reason}`,
      tenantSlug,
      metadata: {
        rule_ids: override.rule_ids,
        reason: override.reason,
        approved_by: override.approved_by,
        source_system: sourceSystem,
        source_id: sourceId,
      },
    });
  }

  // (c3) SA-03 — ingested documents are untrusted input: deterministic
  // injection scan over the (scrubbed) body; suspected content is landed
  // wrapped in the untrusted-content banner so downstream retrieval always
  // sees the neutralizing frame.
  const injection = scanForInjection(scrub.body);
  const untrustedWrapped = injection.injection_suspected;
  const finalBody = untrustedWrapped
    ? wrapUntrusted(scrub.body, `${sourceSystem}::${sourceId}`)
    : scrub.body;
  const finalCard =
    scrub.frontmatter_block !== null ? `${scrub.frontmatter_block}\n\n${finalBody}\n` : finalBody;
  const appliedRuleIds = scrub.applied.map((entry) => entry.rule_id);
  const baseTransformChain =
    Array.isArray(input.transform_chain) && input.transform_chain.length > 0
      ? input.transform_chain
      : ['normalize_card'];
  const transformChain = [
    ...baseTransformChain,
    ...(appliedRuleIds.length > 0 ? [`pii_scrub:${appliedRuleIds.join(',')}`] : []),
    ...(untrustedWrapped ? ['untrusted_wrap'] : []),
  ];
  const stewardApprovalId = stewardApproval?.candidate_id;

  const ingestedAt = String(input.now || '').trim() || nowIso();
  const assetId = deriveAssetId(sourceSystem, sourceId);

  // Ledger reads/writes and the card write all run under the narrowly-scoped
  // ingest_commit authority role — the only grant into knowledge/confidential/
  // this actuator ever uses. The audit record is emitted AFTER leaving the
  // context so it carries the caller's own identity (and the caller's
  // customer-mirror permissions, when it has them).
  const committed = withExecutionContext(INGEST_COMMIT_ROLE, () => {
    const prior = findAssetBySource(tenantSlug, sourceSystem, sourceId, pathOptions);

    let version = 1;
    let supersedes: string | undefined;
    let landingRelative = normalized.target_path.split(/[\\/]/).join('/');
    let landingAbsolute = absTarget;

    if (prior) {
      // SUPERSEDE: same target_path as the prior version (overwrite), version+1.
      version = prior.version + 1;
      supersedes = `${prior.asset_id}@v${prior.version}`;
      landingAbsolute = assertTargetInsideTenantRoot(prior.target_path, knowledgeRoot, rootDir);
      landingRelative = prior.target_path;
    } else if (input.dedup_result?.supersedes_candidate) {
      // Same source seen by the dedup registry before any ledger record
      // existed: keep the registry's landing path when it has one, and
      // record what content this ingest replaces.
      const candidate = input.dedup_result.supersedes_candidate;
      supersedes = `sha256:${candidate.content_sha256}`;
      if (candidate.target_path) {
        landingAbsolute = assertTargetInsideTenantRoot(
          candidate.target_path,
          knowledgeRoot,
          rootDir
        );
        landingRelative = candidate.target_path;
      }
    }

    const record: IngestAssetRecord = {
      asset_id: assetId,
      source_system: sourceSystem,
      source_id: sourceId,
      ...(input.source_meta?.source_url || frontmatterString(frontmatter, 'source_url')
        ? {
            source_url:
              input.source_meta?.source_url || frontmatterString(frontmatter, 'source_url'),
          }
        : {}),
      ...(input.source_meta?.source_version || frontmatterString(frontmatter, 'source_version')
        ? {
            source_version:
              input.source_meta?.source_version || frontmatterString(frontmatter, 'source_version'),
          }
        : {}),
      content_sha256: contentSha256,
      retrieved_at:
        String(input.source_meta?.retrieved_at || '').trim() ||
        frontmatterString(frontmatter, 'retrieved_at') ||
        ingestedAt,
      ingested_at: ingestedAt,
      ingested_by: ingestedBy,
      ...(String(input.approval_id || '').trim()
        ? { approval_id: String(input.approval_id || '').trim() }
        : {}),
      ...(stewardApprovalId ? { steward_approval_id: stewardApprovalId } : {}),
      visible_to:
        Array.isArray(input.visible_to) && input.visible_to.length > 0
          ? input.visible_to
          : [tenantSlug],
      transform_chain: transformChain,
      target_path: landingRelative,
      version,
      ...(supersedes ? { supersedes } : {}),
      status: 'active',
    };

    // (d) land the SCRUBBED card and (e) append the ledger record — same ceremony.
    safeMkdir(path.dirname(landingAbsolute), { recursive: true });
    safeWriteFile(landingAbsolute, finalCard, { encoding: 'utf8' });
    appendAssetRecord(tenantSlug, record, pathOptions);

    return {
      committed: true as const,
      asset: record,
      provenance_ref: assetProvenanceRef(record),
      target_path: landingRelative,
      absolute_path: landingAbsolute,
      ...(appliedRuleIds.length > 0 ? { pii_scrub_applied: appliedRuleIds } : {}),
      ...(untrustedWrapped ? { untrusted_wrap: true } : {}),
    };
  });

  // DA-08: the commit landed — count it against today's quota. Best-effort:
  // a counter write failure must not un-land the card (it is already on disk
  // and in the ledger); it only loses one tick of budget accounting.
  if (quota) {
    try {
      recordIngestUsage(tenantSlug, cardBytes, 1, { rootDir, now: quotaNow });
    } catch (err) {
      logger.warn(
        `[ingest:commit] quota usage recording failed for '${tenantSlug}': ` +
          `${err instanceof Error ? err.message : err}`
      );
    }
  }

  // DA-06 loop closure: a consumed steward approval is marked 'promoted'
  // with the landed provenance ref. Best-effort — the landing itself already
  // carries the approval id in the ledger and the audit record.
  if (stewardApproval && stewardApproval.status === 'approved') {
    try {
      updateMemoryPromotionCandidateStatus({
        candidateId: stewardApproval.candidate_id,
        status: 'promoted',
        promotedRef: committed.provenance_ref,
        ratificationNote: `ingest:commit landed ${committed.target_path}`,
      });
    } catch (err) {
      logger.warn(
        `[ingest:commit] could not mark steward approval ${stewardApproval.candidate_id} promoted: ` +
          `${err instanceof Error ? err.message : err}`
      );
    }
  }

  const record = committed.asset;
  auditChain.record({
    agentId: 'ingest-actuator',
    action: 'ingest.commit',
    operation: committed.target_path,
    result: 'completed',
    reason: record.supersedes
      ? `Superseded ${record.supersedes} with version ${record.version} of asset ${assetId}.`
      : `Landed version 1 of asset ${assetId}.`,
    tenantSlug,
    metadata: {
      asset_id: assetId,
      version: record.version,
      tenant_slug: tenantSlug,
      source_system: sourceSystem,
      source_id: sourceId,
      content_sha256: contentSha256,
      transform_chain: record.transform_chain,
      ...(record.approval_id ? { approval_id: record.approval_id } : {}),
      ...(stewardApprovalId ? { steward_approval_id: stewardApprovalId } : {}),
      ...(appliedRuleIds.length > 0 ? { pii_scrub_applied: appliedRuleIds } : {}),
      ...(untrustedWrapped ? { untrusted_wrap: true } : {}),
      ...(override
        ? {
            scrub_override: {
              rule_ids: override.rule_ids,
              reason: override.reason,
              approved_by: override.approved_by,
            },
          }
        : {}),
      ...(record.supersedes ? { supersedes: record.supersedes } : {}),
      ...(quota && quota.level === 'warn'
        ? {
            quota: {
              level: quota.level,
              warned: quota.warned,
              projected: quota.projected,
              limit: quota.limit,
            },
          }
        : {}),
      ingested_by: ingestedBy,
    },
  });

  return { ...committed, ...(quota ? { quota_level: quota.level } : {}) };
}

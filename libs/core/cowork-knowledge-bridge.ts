/**
 * Cowork Knowledge Bridge (Phase 3 — G3/軸A)
 *
 * Bidirectional knowledge sync between Kyberion's 3-tier knowledge base
 * and the Claude Cowork workspace.
 *
 * Direction 1 — Cowork → Kyberion (ingest):
 *   Read Cowork work-folder artifacts → classify tier via sync-policy →
 *   enqueue to memory-promotion-queue (tier-guard enforced).
 *
 * Direction 2 — Kyberion → Cowork (supply):
 *   Read public knowledge tier → hash-diff for idempotency →
 *   deliver changed/new hints to Cowork via cowork-surface outbox.
 *
 * Idempotency: both directions use SHA-256 content hashes stored in
 *   active/shared/runtime/cowork-sync-state.json
 *
 * Architecture rules (AGENTS.md R1/R5):
 *   - All I/O via secure-io
 *   - tier-guard: personal/confidential content NEVER flows to Cowork
 *   - Hash-diff prevents re-promotion of already-queued content
 */

import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
  safeMkdir,
} from './secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  type MemoryCandidateTier,
  type MemoryCandidateKind,
} from './memory-promotion-queue.js';
import { deliverToCowork } from './cowork-surface.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncState {
  /** Map from source_ref → content hash */
  ingested: Record<string, string>;
  /** Map from knowledge path → content hash */
  supplied: Record<string, string>;
  last_sync_at: string;
}

export interface IngestResult {
  enqueued: number;
  skipped_duplicate: number;
  skipped_tier_violation: number;
  candidate_ids: string[];
  errors: string[];
}

export interface SupplyResult {
  delivered: number;
  skipped_unchanged: number;
  delivery_id?: string;
  errors: string[];
}

export interface BridgeSyncResult {
  direction: 'cowork-to-kyberion' | 'kyberion-to-cowork' | 'both';
  ingest?: IngestResult;
  supply?: SupplyResult;
  sync_state_path: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SYNC_STATE_LOGICAL = 'active/shared/runtime/cowork-sync-state.json';
const POLICY_PATH = pathResolver.rootResolve(
  'knowledge/product/governance/cowork-sync-policy.json',
);

// ─── Sync state helpers ───────────────────────────────────────────────────────

function loadSyncState(): SyncState {
  const resolved = pathResolver.resolve(SYNC_STATE_LOGICAL);
  if (!safeExistsSync(resolved)) {
    return { ingested: {}, supplied: {}, last_sync_at: '' };
  }
  try {
    return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as SyncState;
  } catch {
    return { ingested: {}, supplied: {}, last_sync_at: '' };
  }
}

function saveSyncState(state: SyncState): void {
  const resolved = pathResolver.resolve(SYNC_STATE_LOGICAL);
  const dir = nodePath.dirname(resolved);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(resolved, JSON.stringify({ ...state, last_sync_at: new Date().toISOString() }, null, 2));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Policy helpers ───────────────────────────────────────────────────────────

interface SyncPolicy {
  cowork_to_kyberion: {
    default_sensitivity_tier: MemoryCandidateTier;
    default_ratification_required: boolean;
    kind_inference: { pattern: string; proposed_kind: MemoryCandidateKind }[];
    tier_assignment: {
      rules: { source_path_pattern: string; assigned_tier: MemoryCandidateTier; ratification_required: boolean }[];
      default: MemoryCandidateTier;
    };
  };
  kyberion_to_cowork: {
    allowed_tiers: string[];
    domains: string[];
    delivery: { max_hints_per_sync: number };
  };
}

function loadPolicy(): SyncPolicy | null {
  if (!safeExistsSync(POLICY_PATH)) return null;
  try {
    return JSON.parse(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string) as SyncPolicy;
  } catch {
    return null;
  }
}

function inferKind(name: string, policy: SyncPolicy): MemoryCandidateKind {
  for (const rule of policy.cowork_to_kyberion.kind_inference) {
    if (new RegExp(rule.pattern).test(name)) return rule.proposed_kind;
  }
  return 'heuristic';
}

function inferTier(sourcePath: string, policy: SyncPolicy): { tier: MemoryCandidateTier; ratificationRequired: boolean } {
  for (const rule of policy.cowork_to_kyberion.tier_assignment.rules) {
    if (new RegExp(rule.source_path_pattern).test(sourcePath)) {
      return { tier: rule.assigned_tier, ratificationRequired: rule.ratification_required };
    }
  }
  return {
    tier: policy.cowork_to_kyberion.tier_assignment.default as MemoryCandidateTier,
    ratificationRequired: policy.cowork_to_kyberion.default_ratification_required,
  };
}

// ─── Direction 1: Cowork → Kyberion ──────────────────────────────────────────

/**
 * Ingest a list of Cowork artifact paths into the Kyberion memory-promotion-queue.
 *
 * Each artifact is:
 *   1. Read from disk via secure-io
 *   2. Hash-checked against sync state (skip if unchanged)
 *   3. Tier-classified via cowork-sync-policy.json
 *   4. Enqueued via enqueueMemoryPromotionCandidate (tier-guard enforced by queue)
 *
 * @param artifactPaths  Absolute or repo-relative paths to Cowork output files.
 */
export function ingestCoworkArtifacts(artifactPaths: string[]): IngestResult {
  const policy = loadPolicy();
  const state = loadSyncState();
  const result: IngestResult = { enqueued: 0, skipped_duplicate: 0, skipped_tier_violation: 0, candidate_ids: [], errors: [] };

  const existingRefs = new Set(listMemoryPromotionCandidates().map((c) => c.source_ref));

  for (const rawPath of artifactPaths) {
    const absPath = nodePath.isAbsolute(rawPath) ? rawPath : pathResolver.rootResolve(rawPath);
    const sourceRef = rawPath;

    if (!safeExistsSync(absPath)) {
      result.errors.push(`File not found: ${sourceRef}`);
      continue;
    }

    let content: string;
    try {
      content = safeReadFile(absPath, { encoding: 'utf8' }) as string;
    } catch (err) {
      result.errors.push(`Cannot read ${sourceRef}: ${err}`);
      continue;
    }

    const contentHash = sha256(content);
    const prevHash = state.ingested[sourceRef];

    // Skip unchanged (idempotency)
    if (prevHash === contentHash && existingRefs.has(sourceRef)) {
      result.skipped_duplicate++;
      continue;
    }

    // Tier inference
    const tierInfo = policy
      ? inferTier(sourceRef, policy)
      : { tier: 'confidential' as MemoryCandidateTier, ratificationRequired: true };
    const kind = policy ? inferKind(nodePath.basename(sourceRef), policy) : 'heuristic';

    // Tier-guard: block personal/confidential from having public evidence refs
    // (enforced further down in enqueueMemoryPromotionCandidate)

    try {
      const candidate = createMemoryPromotionCandidate({
        sourceType: 'artifact',
        sourceRef,
        proposedMemoryKind: kind,
        summary: `Cowork artifact: ${nodePath.basename(sourceRef)} (${content.length} chars)`,
        evidenceRefs: [sourceRef],
        sensitivityTier: tierInfo.tier,
        ratificationRequired: tierInfo.ratificationRequired,
      });
      enqueueMemoryPromotionCandidate(candidate);
      state.ingested[sourceRef] = contentHash;
      result.enqueued++;
      result.candidate_ids.push(candidate.candidate_id);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Public-tier') || msg.includes('POLICY_VIOLATION')) {
        result.skipped_tier_violation++;
        result.errors.push(`Tier violation for ${sourceRef}: ${msg}`);
      } else {
        result.errors.push(`Failed to enqueue ${sourceRef}: ${msg}`);
      }
    }
  }

  saveSyncState(state);
  return result;
}

// ─── Direction 2: Kyberion → Cowork ──────────────────────────────────────────

/**
 * Supply public Kyberion knowledge hints to the Cowork outbox.
 *
 * Only `public` tier knowledge is exported (R5: no confidential/personal leakage).
 * Hash-diff ensures unchanged hints are not re-delivered.
 */
export function supplyKnowledgeToCowork(options: { maxHints?: number } = {}): SupplyResult {
  const policy = loadPolicy();
  const maxHints = options.maxHints ?? policy?.kyberion_to_cowork.delivery.max_hints_per_sync ?? 50;
  const state = loadSyncState();
  const result: SupplyResult = { delivered: 0, skipped_unchanged: 0, errors: [] };

  const publicRoot = pathResolver.rootResolve('knowledge/public');
  if (!safeExistsSync(publicRoot)) {
    result.errors.push('knowledge/public does not exist');
    return result;
  }

  const domains = policy?.kyberion_to_cowork.domains ?? ['procedures', 'architecture', 'governance'];
  const hintsToDeliver: { path: string; content: string }[] = [];

  for (const domain of domains) {
    const domainDir = nodePath.join(publicRoot, domain);
    if (!safeExistsSync(domainDir)) continue;
    collectMarkdownFiles(domainDir, hintsToDeliver, state, maxHints - hintsToDeliver.length, result);
    if (hintsToDeliver.length >= maxHints) break;
  }

  if (hintsToDeliver.length === 0) return result;

  // Deliver as a single Cowork packet
  try {
    const combinedContent = hintsToDeliver
      .map((h) => `## ${nodePath.basename(h.path)}\n\n${h.content}`)
      .join('\n\n---\n\n');

    const deliveryId = deliverToCowork(
      [{ content: combinedContent, content_type: 'text/markdown', description: 'Kyberion public knowledge supply' }],
      {
        title: `Kyberion Knowledge Update (${hintsToDeliver.length} hints)`,
        summary: `Synced ${hintsToDeliver.length} public knowledge hints from Kyberion to Cowork.`,
        nextAction: 'Review the knowledge hints and use them in your Cowork session.',
      },
    );

    // Update state for delivered hints
    for (const h of hintsToDeliver) {
      state.supplied[h.path] = sha256(h.content);
    }
    saveSyncState(state);

    result.delivered = hintsToDeliver.length;
    result.delivery_id = deliveryId;
  } catch (err) {
    result.errors.push(`Delivery failed: ${err}`);
  }

  return result;
}

function collectMarkdownFiles(
  dir: string,
  collected: { path: string; content: string }[],
  state: SyncState,
  remaining: number,
  result: SupplyResult,
): void {
  if (remaining <= 0) return;
  const initialCount = collected.length;
  let entries: string[];
  try {
    entries = safeReaddir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const addedThisCall = collected.length - initialCount;
    if (addedThisCall >= remaining) break;
    const fullPath = nodePath.join(dir, entry);
    if (entry.endsWith('.md') || entry.endsWith('.txt')) {
      try {
        const content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
        const hash = sha256(content);
        if (state.supplied[fullPath] === hash) {
          result.skipped_unchanged++;
          continue;
        }
        collected.push({ path: fullPath, content });
      } catch {
        // skip unreadable
      }
    } else if (!entry.includes('.')) {
      // Recurse into subdirectories (no extension = likely directory)
      const remainingBudget = remaining - (collected.length - initialCount);
      collectMarkdownFiles(fullPath, collected, state, remainingBudget, result);
    }
  }
}

// ─── Combined sync entry point ────────────────────────────────────────────────

/**
 * Run full bidirectional sync.
 * Called by `pnpm knowledge:cowork-sync` or the MCP tool.
 */
export function runCoworkKnowledgeSync(params: {
  coworkArtifactPaths?: string[];
  direction?: 'cowork-to-kyberion' | 'kyberion-to-cowork' | 'both';
  maxHints?: number;
}): BridgeSyncResult {
  const direction = params.direction ?? 'both';
  const statePath = pathResolver.resolve(SYNC_STATE_LOGICAL);

  const syncResult: BridgeSyncResult = { direction, sync_state_path: statePath };

  if (direction === 'cowork-to-kyberion' || direction === 'both') {
    syncResult.ingest = ingestCoworkArtifacts(params.coworkArtifactPaths ?? []);
  }
  if (direction === 'kyberion-to-cowork' || direction === 'both') {
    syncResult.supply = supplyKnowledgeToCowork({ maxHints: params.maxHints });
  }

  return syncResult;
}

/**
 * knowledge-hygiene-probe — periodic autonomous sweep over the memory
 * promotion queue and generated patterns. Growth hygiene: duplicates,
 * stale pending candidates, and superseded records surface as findings +
 * WorkItems for the ops dot instead of accumulating silently.
 */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { appendJsonLine } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import { reviewMemoryPromotionQueue } from './memory-promotion-review.js';
import { createWorkItemIfAbsent } from '../workforce/work-coordination.js';
import { OPS_FINDINGS_PATH, OPS_WORK_ITEM_DOT_ID } from '../ops-health-probe.js';

const logger = createLogger('knowledge-hygiene-probe');

export const KNOWLEDGE_STALE_DAYS = 14;

export interface KnowledgeHygieneFinding {
  finding_id: string;
  kind: 'duplicate_candidates' | 'stale_candidate' | 'superseded_records';
  severity: 'info' | 'warning';
  summary: string;
  evidence: Record<string, unknown>;
  detected_at: string;
}

export interface KnowledgeHygieneDeps {
  rootDir?: string;
  now?: () => Date;
  fileWorkItems?: boolean;
}

function fid(kind: string, key: string): string {
  return `knowledge-hygiene:${kind}:${key.slice(0, 120)}`;
}

export function runKnowledgeHygieneProbe(deps: KnowledgeHygieneDeps = {}): {
  findings: KnowledgeHygieneFinding[];
  work_items_filed: string[];
} {
  const now = deps.now?.() ?? new Date();
  const findings: KnowledgeHygieneFinding[] = [];
  for (const review of reviewMemoryPromotionQueue()) {
    if (review.duplicate_count > 0) {
      findings.push({
        finding_id: fid('duplicate_candidates', review.candidate_id),
        kind: 'duplicate_candidates',
        severity: 'warning',
        summary: `${review.duplicate_count + 1} queued records map to ${review.candidate_id} (${review.target_kind}) — consolidate before promote`,
        evidence: {
          candidate_id: review.candidate_id,
          duplicates: review.duplicate_count,
          queue_statuses: review.queue_statuses,
        },
        detected_at: now.toISOString(),
      });
    }
    if (review.record_conflicts.length > 0) {
      findings.push({
        finding_id: fid('superseded_records', review.candidate_id),
        kind: 'superseded_records',
        severity: 'warning',
        summary: `promotion candidate ${review.candidate_id} conflicts with ${review.record_conflicts.length} existing record(s) — supersede/merge needed`,
        evidence: { candidate_id: review.candidate_id, conflicts: review.record_conflicts },
        detected_at: now.toISOString(),
      });
    }
    const ageDays = (now.getTime() - Date.parse(review.candidate.queued_at)) / 86_400_000;
    if (review.queue_statuses.every((s) => s === 'queued') && ageDays >= KNOWLEDGE_STALE_DAYS) {
      findings.push({
        finding_id: fid('stale_candidate', review.candidate_id),
        kind: 'stale_candidate',
        severity: 'info',
        summary: `promotion candidate ${review.candidate_id} pending ${Math.floor(ageDays)}d — promote, or archive to stop queue noise`,
        evidence: {
          candidate_id: review.candidate_id,
          age_days: Math.floor(ageDays),
          lane: review.promotion_lane,
        },
        detected_at: now.toISOString(),
      });
    }
  }
  if (findings.length === 0) return { findings, work_items_filed: [] };

  const findingsPath = path.join(deps.rootDir ?? pathResolver.rootDir(), OPS_FINDINGS_PATH);
  const filed: string[] = [];
  safeMkdir(path.dirname(findingsPath), { recursive: true });
  for (const f of findings) {
    appendJsonLine(findingsPath, f);
    if (deps.fileWorkItems) {
      try {
        createWorkItemIfAbsent({
          itemId: f.finding_id,
          title: `[knowledge] ${f.summary.slice(0, 120)}`,
          description: `Detected by knowledge-hygiene-probe. Evidence: ${JSON.stringify(f.evidence)}`,
          labels: ['ops-health', 'knowledge-hygiene', f.kind, `severity:${f.severity}`],
          metadata: { dot_id: OPS_WORK_ITEM_DOT_ID, requested_work_shape: 'direct_reply' },
          rootDir: deps.rootDir,
        });
        filed.push(f.finding_id);
      } catch (e) {
        logger.warn(
          `[KNOWLEDGE-HYGIENE] work item filing failed for ${f.finding_id} | evidence: ${e instanceof Error ? e.message : e}`
        );
      }
    }
  }
  logger.info(
    `[KNOWLEDGE-HYGIENE] ${findings.length} finding(s), ${filed.length} work item(s) filed`
  );
  return { findings, work_items_filed: filed };
}

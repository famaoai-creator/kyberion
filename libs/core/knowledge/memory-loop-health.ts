/**
 * Memory loop health (D8 / MEMORY_LOOP_CLOSURE M1).
 *
 * promoted → retrieved → used, over a time window:
 *   - promoted: promoted records on disk (`isPromotedKnowledgePath`) for the
 *     product/public lanes plus each listed tenant's evolution lane;
 *   - retrieved: distinct promoted records delivered — included in a context
 *     pack (`recordKnowledgeDelivery` → usage aggregate `last_delivered_at`)
 *     — within the window;
 *   - used: distinct promoted records a worker reported as used
 *     (`recordKnowledgeUsageFeedback` → `last_used_at`) within the window.
 *
 * Reads the KP-05 usage aggregates only (read-only, deterministic). Warnings
 * — advisory, never a gate — are attached when records exist but none reach
 * context packs (`warning`) or when retrieved records are never cited (`usage_warning`).
 */
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { loadKnowledgeUsageAggregate } from './knowledge-feedback-loop.js';
import type { KnowledgeUsageAggregateEntry } from './knowledge-usage-aggregate.js';
import { isPromotedKnowledgePath } from './promoted-knowledge-retrieval.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const KINDS = ['wisdom', 'operations', 'patterns', 'templates'] as const;
export const MEMORY_LOOP_DEFAULT_WINDOW_DAYS = 28;

export type MemoryLoopStatus = 'idle' | 'delivery_open' | 'usage_open' | 'closed';

export interface MemoryLoopHealth {
  window_days: number;
  window_start: string;
  promoted: number;
  retrieved: number;
  used: number;
  loop_status: MemoryLoopStatus;
  retrieval_rate: number;
  utilization_rate: number;
  /** Advisory: present when promoted > 0 and retrieved === 0 in the window. */
  warning?: string;
  /** Advisory: present when retrieved > 0 and used === 0 in the window. */
  usage_warning?: string;
}

export interface ComputeMemoryLoopHealthOptions {
  now?: Date;
  windowDays?: number;
  /** Tenants whose own evolution lane and usage aggregate are included. */
  tenants?: string[];
  /** Test seam: repo root containing a fixture `knowledge/`. */
  rootDir?: string;
  /** Test seam: aggregate loader (defaults to the KP-05 loader). */
  loadAggregate?: (tenantSlug?: string) => KnowledgeUsageAggregateEntry[];
}

function countMarkdown(knowledgeBase: string, relativeDir: string): number {
  const dir = path.join(knowledgeBase, relativeDir);
  try {
    if (!safeExistsSync(dir)) return 0;
    return safeReaddir(dir).filter((name) =>
      isPromotedKnowledgePath(`knowledge/${relativeDir}/${name}`)
    ).length;
  } catch {
    // A lane the caller may not list contributes nothing (fail-open).
    return 0;
  }
}

function countPromotedRecords(knowledgeBase: string, tenants: string[]): number {
  let total = 0;
  for (const kind of KINDS) {
    total += countMarkdown(knowledgeBase, `product/evolution/${kind}/generated`);
    total += countMarkdown(knowledgeBase, `public/common/${kind}/generated`);
    for (const tenant of tenants) {
      total += countMarkdown(knowledgeBase, `confidential/${tenant}/evolution/${kind}`);
    }
  }
  return total;
}

function withinWindow(at: string | undefined, startMs: number): boolean {
  const parsed = at ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) && parsed >= startMs;
}

function roundRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function deriveLoopStatus(
  promoted: number,
  retrievedCount: number,
  usedCount: number
): MemoryLoopStatus {
  if (promoted === 0) return 'idle';
  if (retrievedCount === 0) return 'delivery_open';
  if (usedCount === 0) return 'usage_open';
  return 'closed';
}

export function computeMemoryLoopHealth(
  options: ComputeMemoryLoopHealthOptions = {}
): MemoryLoopHealth {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? MEMORY_LOOP_DEFAULT_WINDOW_DAYS;
  const startMs = now.getTime() - windowDays * MS_PER_DAY;
  const tenants = options.tenants ?? [];
  const knowledgeBase = options.rootDir
    ? path.join(options.rootDir, 'knowledge')
    : pathResolver.knowledge();
  const load =
    options.loadAggregate ??
    ((tenantSlug?: string) =>
      loadKnowledgeUsageAggregate(
        tenantSlug ? { tier: 'confidential', tenant_slug: tenantSlug } : undefined
      ));

  const retrieved = new Set<string>();
  const used = new Set<string>();
  for (const tenant of [undefined, ...tenants]) {
    let entries: KnowledgeUsageAggregateEntry[];
    try {
      entries = load(tenant);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!isPromotedKnowledgePath(entry.document_path)) continue;
      const key = `${tenant ?? ''}:${entry.document_path}`;
      const deliveredAt =
        entry.last_delivered_at ?? (entry.delivered_count > 0 ? entry.last_seen : undefined);
      const usedAt = entry.last_used_at ?? (entry.used_count > 0 ? entry.last_seen : undefined);
      if (entry.delivered_count > 0 && withinWindow(deliveredAt, startMs)) retrieved.add(key);
      if (entry.used_count > 0 && withinWindow(usedAt, startMs)) used.add(key);
    }
  }

  const promoted = countPromotedRecords(knowledgeBase, tenants);
  const retrievedCount = retrieved.size;
  const usedCount = used.size;
  const loopStatus = deriveLoopStatus(promoted, retrievedCount, usedCount);
  const health: MemoryLoopHealth = {
    window_days: windowDays,
    window_start: new Date(startMs).toISOString(),
    promoted,
    retrieved: retrievedCount,
    used: usedCount,
    loop_status: loopStatus,
    retrieval_rate: roundRate(retrievedCount, promoted),
    utilization_rate: roundRate(usedCount, retrievedCount),
  };
  if (promoted > 0 && retrievedCount === 0) {
    health.warning =
      `memory loop open — ${promoted} promoted record(s), none retrieved into a context pack in the last ${windowDays} day(s)` +
      ' | next: check findRelevantPromotedKnowledge results and knowledge-slices excludes' +
      ' | evidence: KP-05 usage aggregate (runtime/feedback-loop/knowledge-usage)';
  } else if (retrievedCount > 0 && usedCount === 0) {
    health.usage_warning =
      `memory loop usage unmeasured — ${retrievedCount} promoted record(s) delivered, none reported used in the last ${windowDays} day(s)` +
      ' | next: report used refs via dot_cite_knowledge_used or mission record-evidence --knowledge-used' +
      ' | evidence: KP-05 usage aggregate (runtime/feedback-loop/knowledge-usage)';
  }
  return health;
}

/** One report line: `promoted N → retrieved N → used N (window Dd)`. */
export function formatMemoryLoopHealthLine(health: MemoryLoopHealth): string {
  return `memory_loop: promoted ${health.promoted} → retrieved ${health.retrieved} → used ${health.used} (last ${health.window_days} days)`;
}

/** Detailed multi-part summary including status and retrieval/utilization rates. */
export function formatMemoryLoopHealthDetail(health: MemoryLoopHealth): string {
  const retrievalPct = Math.round(health.retrieval_rate * 100);
  const utilizationPct = Math.round(health.utilization_rate * 100);
  return `${formatMemoryLoopHealthLine(health)} [${health.loop_status}; retrieval=${retrievalPct}%, utilization=${utilizationPct}%]`;
}

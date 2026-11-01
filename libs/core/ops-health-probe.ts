/**
 * ops-health-probe — stage 1+2 of the autonomous improvement loop.
 *
 * Aggregates cheap, deterministic metrics that have historically signalled
 * long-term operational barriers, and files a deduplicated WorkItem per
 * finding so the dot/executor side of the loop can claim and fix it.
 *
 * Signals (each mirrors a defect class fixed in MSN-LOG-STORE-HARDENING /
 * MSN-DOT-LEDGER-COMPACTION):
 *   - append-only store growth: a cataloged `.jsonl` exceeding its action
 *     threshold budget (rotate_min_bytes / compact_min_bytes)
 *   - alert concentration: one dedupe key dominating ops-alerts.jsonl
 *     (> ALERT_DOMINANCE_RATIO of records) — alert fatigue that hides real
 *     signal, as when 93% of alerts were one daemon watchdog message
 *   - uncovered runtime stores: files reported by storage-runtime-coverage
 *     with no catalog entry — the "silent forever retention" hole
 *
 * Findings land in `active/shared/observability/ops-findings.jsonl` (append-
 * only, cataloged) and each produces a `createWorkItemIfAbsent` ticket keyed
 * by a stable finding id so re-runs never duplicate work.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeStat,
} from './secure-io.js';
import { appendJsonLine } from './foundation/json.js';
import { streamJsonLines } from './jsonl-read.js';
import { createLogger } from './logger.js';
import { createWorkItemIfAbsent } from './workforce/work-coordination.js';
import { appendDotInboxEntry } from './dot/dot-inbox.js';
import { listDotCharters } from './dot/dot-charter.js';
import { loadRetentionCatalog, type RetentionCatalogEntry } from './storage-retention-catalog.js';
import { DEFAULT_COMPACT_MIN_BYTES, DEFAULT_ROTATE_MIN_BYTES } from './storage-retention-expiry.js';
import { listUncoveredRuntimeFiles, listUncoveredRuntimeDirs } from './storage-runtime-coverage.js';

const logger = createLogger('ops-health-probe');

export const OPS_FINDINGS_PATH = 'active/shared/observability/ops-findings.jsonl';
/** Dot that diagnoses filed ops-health findings (allowed shapes:
 *  direct_reply | pipeline | mission — direct_reply keeps it advisory). */
export const OPS_WORK_ITEM_DOT_ID = 'org-operations';
export const OPS_ALERTS_PATH = 'active/shared/observability/ops-alerts.jsonl';

/** One alert key owning this share of the log = alert fatigue. */
export const ALERT_DOMINANCE_RATIO = 0.5;
/** An append-only store over this multiple of its compact/rotate threshold is a finding. */
export const STORE_OVERGROWTH_FACTOR = 2;
/** Minimum absolute size before an over-threshold store is worth a ticket. */
export const STORE_MIN_BYTES = 1024 * 1024;
/** Ungoverned-growth ceiling for review_required / action-less stores — the delegations.jsonl 13MB class. */
export const REVIEW_REQUIRED_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Probe-cost caps for walking review_required runtime directories (not store
 * correctness bounds): how deep the walk descends and how many directory
 * entries it visits per cataloged directory before moving on.
 */
export const DIRECTORY_PROBE_MAX_DEPTH = 4;
export const DIRECTORY_PROBE_MAX_ENTRIES = 2000;
/** Only runtime-store directories are walked (not archive/knowledge trees). */
const DIRECTORY_PROBE_PREFIX = 'active/shared/runtime/';

export interface OpsFinding {
  /** Stable dedupe identity — same finding class+subject ⇒ same id. */
  finding_id: string;
  kind: 'store_overgrowth' | 'alert_dominance' | 'uncovered_store' | 'stale_compaction_copy';
  severity: 'info' | 'warning' | 'critical';
  summary: string;
  evidence: Record<string, unknown>;
  detected_at: string;
}

function findingId(kind: string, subject: string): string {
  return `ops-finding:${kind}:${createHash('sha256').update(subject).digest('hex').slice(0, 16)}`;
}

export interface OpsHealthProbeDeps {
  rootDir?: string;
  now?: () => Date;
  /** When false (default) only records findings; true also files WorkItems. */
  fileWorkItems?: boolean;
  /** Ceiling for review_required stores (tests inject small values). */
  reviewRequiredMaxBytes?: number;
}

/**
 * Size that should trigger a store's rotate/compact action — the janitor's
 * default when the entry declares none — or undefined for action-less stores.
 */
export function storeActionThreshold(entry: RetentionCatalogEntry): number | undefined {
  if (entry.action === 'rotate') return entry.rotate_min_bytes ?? DEFAULT_ROTATE_MIN_BYTES;
  if (entry.action === 'compact') return entry.compact_min_bytes ?? DEFAULT_COMPACT_MIN_BYTES;
  return undefined;
}

function reviewRequiredFinding(
  rel: string,
  size: number,
  entry: RetentionCatalogEntry,
  deps: OpsHealthProbeDeps
): OpsFinding {
  const where = rel === entry.path ? '' : ` (in ${entry.path})`;
  return {
    finding_id: findingId('store_overgrowth', rel),
    kind: 'store_overgrowth',
    severity: 'warning',
    summary: `review_required store ${rel}${where} at ${(size / 1e6).toFixed(1)}MB with no self-bounding action — needs a lifecycle decision`,
    evidence: {
      path: rel,
      size_bytes: size,
      action: entry.action,
      ...(rel === entry.path ? {} : { catalog_path: entry.path }),
    },
    detected_at: (deps.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * Bounded walk of one review_required runtime directory: every `.jsonl` file
 * over the ceiling is a finding. Children with their own catalog entry are
 * skipped (that entry governs them). A path this role may not read is
 * skipped with a debug log — the probe never fails on access.
 */
function probeReviewRequiredDirectory(
  entry: RetentionCatalogEntry,
  cataloged: ReadonlySet<string>,
  ceiling: number,
  deps: OpsHealthProbeDeps
): OpsFinding[] {
  const findings: OpsFinding[] = [];
  let visited = 0;
  const walk = (rel: string, depth: number): void => {
    let names: string[];
    try {
      names = safeReaddir(repoFile(deps.rootDir, rel));
    } catch (error) {
      logger.debug(
        `[OPS-PROBE] skipped ${rel}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    for (const name of names.sort()) {
      if (visited++ >= DIRECTORY_PROBE_MAX_ENTRIES) return;
      const child = `${rel}/${name}`;
      if (cataloged.has(child)) continue;
      try {
        const stat = safeLstat(repoFile(deps.rootDir, child));
        if (stat.isDirectory()) {
          if (depth < DIRECTORY_PROBE_MAX_DEPTH) walk(child, depth + 1);
        } else if (stat.isFile() && name.endsWith('.jsonl') && stat.size > ceiling) {
          findings.push(reviewRequiredFinding(child, stat.size, entry, deps));
        }
      } catch (error) {
        logger.debug(
          `[OPS-PROBE] skipped ${child}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
  walk(entry.path, 1);
  return findings;
}

function repoFile(rootDir: string | undefined, rel: string): string {
  return assertSafeRepositoryPath(path.join(rootDir ?? pathResolver.rootDir(), rel), {
    allowMissingLeaf: true,
  });
}

/** Append-only stores exceeding their declared action threshold budget. */
export function probeStoreOvergrowth(deps: OpsHealthProbeDeps = {}): OpsFinding[] {
  const catalog = loadRetentionCatalog();
  const findings: OpsFinding[] = [];
  // Cataloged file-level stores: rotate/compact get threshold-multiple checks;
  // action-less or review_required .jsonl files get the fixed ceiling — their
  // mechanism can never fire, so silence is what the probe exists to break.
  // Self-managed stores bound their own live file and report growth through
  // their own finding (e.g. trigger-store-growth), so they are not probed here.
  const targets = catalog.entries.filter(
    (e) => e.path.endsWith('.jsonl') && !e.path.includes('{') && e.self_managed !== true
  );
  const ceiling = deps.reviewRequiredMaxBytes ?? REVIEW_REQUIRED_MAX_BYTES;
  for (const entry of targets) {
    const filePath = repoFile(deps.rootDir, entry.path);
    if (!safeExistsSync(filePath)) continue;
    const size = safeStat(filePath).size;
    const threshold = storeActionThreshold(entry);
    if (threshold === undefined) {
      // No action threshold (review_required etc.) — the mechanism can never
      // fire, so a fixed ceiling is the only bound. Past it the store needs a
      // lifecycle entry or a manual archive decision.
      if (size <= ceiling) continue;
      findings.push(reviewRequiredFinding(entry.path, size, entry, deps));
      continue;
    }
    if (size < threshold * STORE_OVERGROWTH_FACTOR || size < STORE_MIN_BYTES) continue;
    findings.push({
      finding_id: findingId('store_overgrowth', entry.path),
      kind: 'store_overgrowth',
      severity: size > threshold * 8 ? 'critical' : 'warning',
      summary: `append-only store ${entry.path} at ${(size / 1e6).toFixed(1)}MB (${(size / threshold).toFixed(0)}× its ${entry.action} threshold)`,
      evidence: {
        path: entry.path,
        size_bytes: size,
        threshold_bytes: threshold,
        action: entry.action,
      },
      detected_at: (deps.now?.() ?? new Date()).toISOString(),
    });
  }
  // review_required runtime directories (mesh-hub, peer-messaging, ledgers…)
  // hold per-tenant/per-session JSONL files no file-level entry names; the
  // same ceiling applies to each file found by a bounded walk.
  const cataloged = new Set(catalog.entries.map((e) => e.path));
  for (const entry of catalog.entries) {
    if (
      entry.action !== 'review_required' ||
      entry.self_managed === true ||
      !entry.path.startsWith(DIRECTORY_PROBE_PREFIX) ||
      entry.path.includes('{') ||
      /\.(?:jsonl|json|env)$/u.test(entry.path)
    )
      continue;
    findings.push(...probeReviewRequiredDirectory(entry, cataloged, ceiling, deps));
  }
  return findings;
}

/** A `.compacting-*` copy older than this is left over from a failed rewrite. */
export const STALE_COMPACTION_COPY_MS = 60 * 60 * 1000;
/** Trees that hold append-only stores with write-time maintenance. */
export const COMPACTION_COPY_ROOTS = [
  DIRECTORY_PROBE_PREFIX.slice(0, -1),
  'active/shared/observability',
  'active/missions',
] as const;
const COMPACTION_COPY_MAX_DEPTH = 6;
const COMPACTION_COPY_MAX_ENTRIES = 20_000;

/**
 * Leftover `.compacting-*` copies. A parked rewrite keeps its copies when the
 * data would otherwise not be intact (append-only-store `rewriteParked`), and
 * nothing removes them later: parked-aware readers then re-read every copy on
 * each call (the wake ledger bypasses its cache) and agent-input-queue
 * compaction stays skipped. Each copy older than an hour is a finding naming
 * its path so an operator can merge it back into the live store.
 */
export function probeStaleCompactionCopies(deps: OpsHealthProbeDeps = {}): OpsFinding[] {
  const findings: OpsFinding[] = [];
  const now = (deps.now?.() ?? new Date()).getTime();
  let visited = 0;
  const walk = (rel: string, depth: number): void => {
    let names: string[];
    try {
      names = safeReaddir(repoFile(deps.rootDir, rel));
    } catch (error) {
      logger.debug(
        `[OPS-PROBE] skipped ${rel}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    for (const name of names.sort()) {
      if (visited++ >= COMPACTION_COPY_MAX_ENTRIES) return;
      const child = `${rel}/${name}`;
      try {
        const stat = safeLstat(repoFile(deps.rootDir, child));
        if (stat.isDirectory()) {
          if (depth < COMPACTION_COPY_MAX_DEPTH) walk(child, depth + 1);
        } else if (
          stat.isFile() &&
          name.includes('.compacting-') &&
          now - stat.mtimeMs > STALE_COMPACTION_COPY_MS
        ) {
          findings.push({
            finding_id: findingId('stale_compaction_copy', child),
            kind: 'stale_compaction_copy',
            severity: 'warning',
            summary: `leftover compaction copy ${child} (${(stat.size / 1e6).toFixed(1)}MB) — a failed rewrite kept it; parked-aware readers re-read it on every call | next: merge its records back into the live store, then remove it`,
            evidence: {
              path: child,
              size_bytes: stat.size,
              mtime: new Date(stat.mtimeMs).toISOString(),
            },
            detected_at: new Date(now).toISOString(),
          });
        }
      } catch (error) {
        logger.debug(
          `[OPS-PROBE] skipped ${child}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
  for (const root of COMPACTION_COPY_ROOTS) walk(root, 1);
  return findings;
}

/** One alert source dominating the log — the 93%-watchdog defect class.
 *  Keys embed detail segments (daemon sets, minute stamps), so dominance must
 *  group by the source prefix before the first ':' — a per-key count would
 *  fragment one noisy source into many <50% slices and never fire. */
export function probeAlertDominance(deps: OpsHealthProbeDeps = {}): OpsFinding[] {
  const alertPath = repoFile(deps.rootDir, OPS_ALERTS_PATH);
  if (!safeExistsSync(alertPath)) return [];
  const counts = new Map<string, number>();
  const topKey = new Map<string, { key: string; count: number }>();
  let total = 0;
  // Streamed (the live file is rotation-bounded, but size must never make the
  // probe fail) and torn/malformed lines are skipped, not fatal.
  for (const row of streamJsonLines<Record<string, unknown>>(alertPath, {
    onMalformed: 'skip',
  })) {
    // Alert records carry id/title/severity; `kind` is only present on
    // meta-records (undelivered-notification / redelivery / ack markers).
    if (typeof row?.dedupe_key !== 'string' && typeof row?.title !== 'string') continue;
    if (typeof row?.kind === 'string' && row.kind !== 'ops_alert') continue;
    total++;
    const key =
      typeof row.dedupe_key === 'string' ? row.dedupe_key : `${row.severity}:${row.title}`;
    const source = key.split(':', 1)[0] ?? key;
    counts.set(source, (counts.get(source) ?? 0) + 1);
    const t = topKey.get(source);
    if (!t || t.key < key) topKey.set(source, { key, count: 0 });
  }
  if (total < 20) return []; // too little data to call dominance
  const findings: OpsFinding[] = [];
  for (const [source, count] of counts) {
    if (count / total < ALERT_DOMINANCE_RATIO) continue;
    findings.push({
      finding_id: findingId('alert_dominance', source),
      kind: 'alert_dominance',
      severity: 'warning',
      summary: `alert source "${source}" is ${((count / total) * 100).toFixed(0)}% of ops-alerts (${count}/${total}) — signal is drowning (sample: ${(topKey.get(source)?.key ?? '').slice(0, 70)})`,
      evidence: { source, count, total, sample_key: topKey.get(source)?.key },
      detected_at: (deps.now?.() ?? new Date()).toISOString(),
    });
  }
  return findings;
}

/** Top-level runtime stores with no catalog entry — silent forever retention. */
export function probeUncoveredStores(deps: OpsHealthProbeDeps = {}): OpsFinding[] {
  const catalog = loadRetentionCatalog();
  const findings: OpsFinding[] = [];
  for (const rel of [...listUncoveredRuntimeFiles(catalog), ...listUncoveredRuntimeDirs(catalog)]) {
    findings.push({
      finding_id: findingId('uncovered_store', rel),
      kind: 'uncovered_store',
      severity: 'info',
      summary: `runtime store ${rel} has no retention catalog entry — silently ungoverned`,
      evidence: { path: rel },
      detected_at: (deps.now?.() ?? new Date()).toISOString(),
    });
  }
  return findings;
}

export interface OpsHealthProbeResult {
  findings: OpsFinding[];
  findings_path: string;
  work_items_filed: string[];
}

/** Resolve the ops dot's charter scope once per run so filed items carry the
 *  tenant/organization context the cross-tenant claim check requires. */
function opsDotScope(
  deps: OpsHealthProbeDeps
): { tenant_slug?: string; organization_id?: string } | undefined {
  try {
    for (const loaded of listDotCharters(deps.rootDir ?? pathResolver.rootDir(), {
      status: 'active',
    })) {
      const c = 'charter' in loaded ? loaded.charter : loaded;
      if (c.dot_id === OPS_WORK_ITEM_DOT_ID) {
        return {
          ...(c.scope?.tenant_slug ? { tenant_slug: c.scope.tenant_slug } : {}),
          ...(c.scope?.organization_id ? { organization_id: c.scope.organization_id } : {}),
        };
      }
    }
  } catch {
    // Charter load failure must not block filing — an unscoped item is
    // unclaimable but the finding itself is still recorded.
  }
  return undefined;
}

export function runOpsHealthProbe(deps: OpsHealthProbeDeps = {}): OpsHealthProbeResult {
  const findings = [
    ...probeStoreOvergrowth(deps),
    ...probeAlertDominance(deps),
    ...probeUncoveredStores(deps),
    ...probeStaleCompactionCopies(deps),
  ];
  const findingsPath = repoFile(deps.rootDir, OPS_FINDINGS_PATH);
  safeMkdir(path.dirname(findingsPath), { recursive: true });
  // Dedupe findings rows by finding_id: the file is append-only and the probe
  // reruns daily, so the same defect would otherwise produce a new identical
  // row each run and drown the signal.
  const seenIds = new Set<string>();
  for (const row of streamJsonLines<Record<string, unknown>>(findingsPath, {
    onMalformed: 'skip',
  })) {
    if (typeof row?.finding_id === 'string') seenIds.add(row.finding_id);
  }
  const dedupedFindings = findings.filter((f) => {
    if (seenIds.has(f.finding_id)) return false;
    seenIds.add(f.finding_id);
    return true;
  });
  const workItemsFiled: string[] = [];
  // Items that exist now — newly filed or a dedup hit. The wake notifies on
  // the union: an item filed before wakes existed still needs a doorbell.
  const workItemsExisting: string[] = [];
  for (const finding of dedupedFindings) {
    appendJsonLine(findingsPath, finding);
    if (deps.fileWorkItems) {
      try {
        createWorkItemIfAbsent({
          itemId: finding.finding_id,
          title: `[ops] ${finding.summary.slice(0, 120)}`,
          status: 'ready',
          description: `Detected by ops-health-probe. Evidence: ${JSON.stringify(finding.evidence)}`,
          labels: ['ops-health', finding.kind, `severity:${finding.severity}`],
          // Address to the ops dot so the item is actually claimed — an
          // unaddressed item is never picked up (addressedTo requires
          // metadata.dot_id or handoff_to). direct_reply = one bounded
          // advisory turn: the dot diagnoses the finding and reports.
          metadata: {
            dot_id: OPS_WORK_ITEM_DOT_ID,
            requested_work_shape: 'direct_reply',
          },
          // The executor refuses items whose context tenant differs from the
          // charter's — an unscoped item (undefined !== tenant) can NEVER be
          // claimed. Stamp the target dot's own scope so it passes the
          // cross-tenant re-check.
          context: {
            ...(opsDotScope(deps) ?? {}),
            project_id: 'default',
            work_shape: 'routine_operation',
          },
          rootDir: deps.rootDir,
        });
        workItemsFiled.push(finding.finding_id);
        workItemsExisting.push(finding.finding_id);
      } catch (error) {
        // A deduped re-file is not a failure — the item exists and the dot
        // still deserves a wake for it (e.g. filed before wakes existed).
        if (/identity conflict/.test(error instanceof Error ? error.message : String(error)))
          workItemsExisting.push(finding.finding_id);
        else
          logger.warn(
            `[OPS-PROBE] work item filing failed for ${finding.finding_id} | next: finding still recorded in ${OPS_FINDINGS_PATH} | evidence: ${error instanceof Error ? error.message : String(error)}`
          );
      }
    }
  }
  // Ring the doorbell: one coalesced inbox wake tells the ops dot a batch of
  // findings exists. The idempotency key hashes the item set — replays of the
  // same findings cannot stack wakes, and a new batch mints a fresh key so a
  // consumed wake never suppresses new work.
  if (deps.fileWorkItems && workItemsExisting.length > 0) {
    try {
      // This producer emits counts/references only. Route that public signal
      // explicitly to the trusted charter scope instead of an unscoped lane.
      const target = listDotCharters(deps.rootDir ?? pathResolver.rootDir(), {
        status: 'active',
      }).find((loaded) => loaded.charter.dot_id === OPS_WORK_ITEM_DOT_ID);
      if (!target)
        throw new Error('Ops dot is unavailable; repair or activate its charter before delivery');
      appendDotInboxEntry(
        {
          scope: target.charter.scope,
          channel: 'inbox',
          dot_id: OPS_WORK_ITEM_DOT_ID,
          source: 'ops-health-probe',
          idempotency_key: `ops-probe:${createHash('sha256')
            .update(workItemsExisting.slice().sort().join(','))
            .digest('hex')
            .slice(0, 16)}`,
          text: `${workItemsExisting.length} ops-health finding(s) filed — check addressed WorkItems`,
        },
        { rootDir: deps.rootDir }
      );
    } catch (error) {
      logger.warn(
        `[OPS-PROBE] wake append failed — WorkItems filed but dot not notified | next: dot claims on its next trigger | evidence: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  logger.info(
    `[OPS-PROBE] ${findings.length} finding(s), ${workItemsFiled.length} work item(s) filed`
  );
  return { findings, findings_path: findingsPath, work_items_filed: workItemsFiled };
}

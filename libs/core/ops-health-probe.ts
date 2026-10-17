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
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeStat } from './secure-io.js';
import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { createLogger } from './logger.js';
import { createWorkItemIfAbsent } from './workforce/work-coordination.js';
import { loadRetentionCatalog } from './storage-retention-catalog.js';
import { listUncoveredRuntimeFiles, listUncoveredRuntimeDirs } from './storage-runtime-coverage.js';

const logger = createLogger('ops-health-probe');

export const OPS_FINDINGS_PATH = 'active/shared/observability/ops-findings.jsonl';
export const OPS_ALERTS_PATH = 'active/shared/observability/ops-alerts.jsonl';

/** One alert key owning this share of the log = alert fatigue. */
export const ALERT_DOMINANCE_RATIO = 0.5;
/** An append-only store over this multiple of its compact/rotate threshold is a finding. */
export const STORE_OVERGROWTH_FACTOR = 2;
/** Minimum absolute size before an over-threshold store is worth a ticket. */
export const STORE_MIN_BYTES = 1024 * 1024;
/** Ungoverned-growth ceiling for review_required / action-less stores — the delegations.jsonl 13MB class. */
export const REVIEW_REQUIRED_MAX_BYTES = 32 * 1024 * 1024;

export interface OpsFinding {
  /** Stable dedupe identity — same finding class+subject ⇒ same id. */
  finding_id: string;
  kind: 'store_overgrowth' | 'alert_dominance' | 'uncovered_store';
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
  const targets = catalog.entries.filter((e) => e.path.endsWith('.jsonl') && !e.path.includes('{'));
  for (const entry of targets) {
    const filePath = repoFile(deps.rootDir, entry.path);
    if (!safeExistsSync(filePath)) continue;
    const size = safeStat(filePath).size;
    const threshold =
      entry.action === 'rotate' || entry.action === 'compact'
        ? (entry.rotate_min_bytes ?? entry.compact_min_bytes ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(threshold)) {
      // No declared action threshold (review_required etc.) — the mechanism
      // can never fire, so a fixed ceiling is the only bound. Past it the
      // store needs a lifecycle entry or a manual archive decision.
      if (size <= REVIEW_REQUIRED_MAX_BYTES) continue;
      findings.push({
        finding_id: findingId('store_overgrowth', entry.path),
        kind: 'store_overgrowth',
        severity: 'warning',
        summary: `review_required store ${entry.path} at ${(size / 1e6).toFixed(1)}MB with no self-bounding action — needs a lifecycle decision`,
        evidence: { path: entry.path, size_bytes: size, action: entry.action },
        detected_at: (deps.now?.() ?? new Date()).toISOString(),
      });
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
  for (const row of readJsonLines<Record<string, unknown>>(alertPath)) {
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

export function runOpsHealthProbe(deps: OpsHealthProbeDeps = {}): OpsHealthProbeResult {
  const findings = [
    ...probeStoreOvergrowth(deps),
    ...probeAlertDominance(deps),
    ...probeUncoveredStores(deps),
  ];
  const findingsPath = repoFile(deps.rootDir, OPS_FINDINGS_PATH);
  safeMkdir(path.dirname(findingsPath), { recursive: true });
  const workItemsFiled: string[] = [];
  for (const finding of findings) {
    appendJsonLine(findingsPath, finding);
    if (deps.fileWorkItems) {
      try {
        createWorkItemIfAbsent({
          itemId: finding.finding_id,
          title: `[ops] ${finding.summary.slice(0, 120)}`,
          description: `Detected by ops-health-probe. Evidence: ${JSON.stringify(finding.evidence)}`,
          labels: ['ops-health', finding.kind, `severity:${finding.severity}`],
          rootDir: deps.rootDir,
        });
        workItemsFiled.push(finding.finding_id);
      } catch (error) {
        logger.warn(
          `[OPS-PROBE] work item filing failed for ${finding.finding_id} | next: finding still recorded in ${OPS_FINDINGS_PATH} | evidence: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  logger.info(
    `[OPS-PROBE] ${findings.length} finding(s), ${workItemsFiled.length} work item(s) filed`
  );
  return { findings, findings_path: findingsPath, work_items_filed: workItemsFiled };
}

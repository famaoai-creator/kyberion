/**
 * KP-06: effectiveness-driven curation + freshness SLO reporting.
 *
 * Reads KP-05's delivery/usage aggregate (`./knowledge-feedback-loop.ts`,
 * imported read-only — never mutated here) plus the knowledge corpus's
 * frontmatter to produce a deterministic, no-LLM report of:
 *
 *  (a) low-yield hints — delivered >= `low_yield_delivery_threshold` times
 *      with `used_count === 0` (KP-05's usage aggregate).
 *  (b) freshness SLO breaches — kind-based re-verify deadlines applied to a
 *      document's frontmatter `last_updated`, thresholds declared in
 *      `knowledge/product/governance/knowledge-curation-slo.json` (NOT
 *      hardcoded — see `loadCurationSloConfig`).
 *
 * KM-03 guardrail carried over: this module only proposes candidates. No
 * file is deleted, archived, or demoted here — a knowledge_steward reviews
 * `CURATION_REPORT.md` and, if they agree, performs the demotion by hand
 * through the existing supersede/archive machinery (`promoted-memory.ts`).
 *
 * Fully deterministic and synchronous: no reasoning backend, no network,
 * no embeddings — safe to run in hermetic tests and the weekly pipeline.
 *
 * See docs/developer/improvement-plans-2026-07/
 * TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md §KP-06.
 */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from '../secure-io.js';
import { loadKnowledgeUsageAggregate } from './knowledge-feedback-loop.js';
import {
  computeTenantIngestCuration,
  type TenantIngestCurationSection,
} from './knowledge-curation-tenant-ingest.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CurationSloConfig {
  low_yield_delivery_threshold: number;
  freshness_days_by_kind: Record<string, number>;
  default_freshness_days: number;
}

const DEFAULT_SLO_CONFIG: CurationSloConfig = {
  low_yield_delivery_threshold: 5,
  freshness_days_by_kind: {
    governance: 90,
    playbook: 60,
    knowledge_hint: 30,
  },
  default_freshness_days: 180,
};

export interface CurationLowYieldHint {
  document_path: string;
  delivered_count: number;
  used_count: number;
  occurrences: number;
  last_seen: string;
}

export interface CurationFreshnessBreach {
  document_path: string;
  kind: string;
  last_updated: string | null;
  age_days: number | null;
  threshold_days: number;
  reason: 'stale' | 'missing_last_updated';
}

export interface KnowledgeCurationReport {
  generated_at: string;
  config: CurationSloConfig;
  low_yield_hints: CurationLowYieldHint[];
  freshness_breaches: CurationFreshnessBreach[];
  /** DA-08: per-tenant ingested-asset freshness sections (advisory only). */
  tenant_ingest: TenantIngestCurationSection[];
  scanned_document_count: number;
  summary: {
    low_yield_count: number;
    freshness_breach_count: number;
    /** DA-08: total flagged ingested assets across tenants. */
    tenant_ingest_flagged_count: number;
  };
}

function sloConfigPath(): string {
  const override = process.env.KYBERION_CURATION_SLO_CONFIG_PATH?.trim();
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.knowledge('product/governance/knowledge-curation-slo.json');
}

function taxonomyPath(): string {
  const override = process.env.KYBERION_CURATION_TAXONOMY_PATH?.trim();
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.knowledge('product/governance/knowledge-taxonomy.json');
}

function reportPath(): string {
  const override = process.env.KYBERION_CURATION_REPORT_PATH?.trim();
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.knowledge('product/governance/CURATION_REPORT.md');
}

export function knowledgeCurationSloConfigPath(): string {
  return sloConfigPath();
}

export function knowledgeCurationReportPath(): string {
  return reportPath();
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * SLO thresholds are config, not code: this is the only place defaults are
 * declared, and they are used only when the config file is absent/invalid
 * (fail-open — a missing/malformed config must not crash the weekly
 * pipeline, it should just fall back to conservative defaults).
 */
export function loadCurationSloConfig(): CurationSloConfig {
  const filePath = sloConfigPath();
  if (!safeExistsSync(filePath)) return { ...DEFAULT_SLO_CONFIG };
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as Partial<CurationSloConfig>;
    const freshnessByKind: Record<string, number> = {};
    if (parsed.freshness_days_by_kind && typeof parsed.freshness_days_by_kind === 'object') {
      for (const [kind, days] of Object.entries(parsed.freshness_days_by_kind)) {
        if (isPositiveNumber(days)) freshnessByKind[kind] = days;
      }
    }
    return {
      low_yield_delivery_threshold: isPositiveNumber(parsed.low_yield_delivery_threshold)
        ? parsed.low_yield_delivery_threshold
        : DEFAULT_SLO_CONFIG.low_yield_delivery_threshold,
      freshness_days_by_kind:
        Object.keys(freshnessByKind).length > 0
          ? freshnessByKind
          : { ...DEFAULT_SLO_CONFIG.freshness_days_by_kind },
      default_freshness_days: isPositiveNumber(parsed.default_freshness_days)
        ? parsed.default_freshness_days
        : DEFAULT_SLO_CONFIG.default_freshness_days,
    };
  } catch {
    return { ...DEFAULT_SLO_CONFIG };
  }
}

interface TaxonomyDirectoryDefault {
  path_prefix: string;
  kind: string;
}

function loadTaxonomyDirectoryDefaults(): TaxonomyDirectoryDefault[] {
  const filePath = taxonomyPath();
  if (!safeExistsSync(filePath)) return [];
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as { directory_defaults?: TaxonomyDirectoryDefault[] };
    return Array.isArray(parsed.directory_defaults) ? parsed.directory_defaults : [];
  } catch {
    return [];
  }
}

/**
 * Default corpus scan roots are the taxonomy's own `directory_defaults`
 * path prefixes — data-driven, so adding a new governed directory to the
 * taxonomy automatically brings it into freshness scanning. Overridable for
 * hermetic tests via `KYBERION_CURATION_SCAN_ROOTS` (comma-separated).
 */
function scanRoots(): string[] {
  const override = process.env.KYBERION_CURATION_SCAN_ROOTS?.trim();
  if (override) {
    return override
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return loadTaxonomyDirectoryDefaults().map((entry) => entry.path_prefix);
}

function extractFrontmatterValue(content: string, key: string): string | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return undefined;
  const line = fmMatch[1]
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith(`${key}:`));
  if (!line) return undefined;
  const value = line
    .slice(line.indexOf(':') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
  return value || undefined;
}

function kindForPath(
  relPath: string,
  directoryDefaults: TaxonomyDirectoryDefault[]
): string | undefined {
  const normalized = relPath.replace(/\\/g, '/');
  for (const entry of directoryDefaults) {
    if (normalized.startsWith(entry.path_prefix)) return entry.kind;
  }
  return undefined;
}

interface ScannedDoc {
  document_path: string;
  kind: string;
  last_updated?: string;
}

function scanMarkdownDocs(
  root: string,
  directoryDefaults: TaxonomyDirectoryDefault[],
  out: ScannedDoc[]
): void {
  let entries: string[];
  try {
    entries = safeReaddir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = path.join(root, entry);
    let stat;
    try {
      stat = safeStat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      scanMarkdownDocs(fullPath, directoryDefaults, out);
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    let content: string;
    try {
      content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
    } catch {
      continue;
    }
    const relSource = path.relative(pathResolver.rootDir(), fullPath).replace(/\\/g, '/');
    const kind =
      extractFrontmatterValue(content, 'kind') || kindForPath(relSource, directoryDefaults);
    if (!kind) continue; // no declared/inferable kind — not subject to a freshness SLO
    const lastUpdated = extractFrontmatterValue(content, 'last_updated');
    out.push({
      document_path: relSource,
      kind,
      ...(lastUpdated ? { last_updated: lastUpdated } : {}),
    });
  }
}

/**
 * Pure(-ish) computation: reads the KP-05 usage aggregate + the knowledge
 * corpus's frontmatter, returns a deterministic report object. Writes
 * nothing — pair with `writeCurationReport` (or use
 * `generateKnowledgeCurationReport`) to persist it.
 */
export function computeCurationReport(options: { now?: Date } = {}): KnowledgeCurationReport {
  const now = options.now || new Date();
  const config = loadCurationSloConfig();

  const usage = loadKnowledgeUsageAggregate();
  const lowYieldHints: CurationLowYieldHint[] = usage
    .filter(
      (entry) =>
        entry.delivered_count >= config.low_yield_delivery_threshold && entry.used_count === 0
    )
    .map((entry) => ({
      document_path: entry.document_path,
      delivered_count: entry.delivered_count,
      used_count: entry.used_count,
      occurrences: entry.occurrences,
      last_seen: entry.last_seen,
    }))
    .sort((a, b) => a.document_path.localeCompare(b.document_path));

  const directoryDefaults = loadTaxonomyDirectoryDefaults();
  const docs: ScannedDoc[] = [];
  for (const root of scanRoots()) {
    scanMarkdownDocs(pathResolver.rootResolve(root), directoryDefaults, docs);
  }

  const freshnessBreaches: CurationFreshnessBreach[] = [];
  for (const doc of docs) {
    const thresholdDays = config.freshness_days_by_kind[doc.kind] ?? config.default_freshness_days;
    const parsed = doc.last_updated ? Date.parse(doc.last_updated) : NaN;
    if (!doc.last_updated || Number.isNaN(parsed)) {
      freshnessBreaches.push({
        document_path: doc.document_path,
        kind: doc.kind,
        last_updated: doc.last_updated ?? null,
        age_days: null,
        threshold_days: thresholdDays,
        reason: 'missing_last_updated',
      });
      continue;
    }
    const ageDays = Math.floor((now.getTime() - parsed) / MS_PER_DAY);
    if (ageDays > thresholdDays) {
      freshnessBreaches.push({
        document_path: doc.document_path,
        kind: doc.kind,
        last_updated: doc.last_updated,
        age_days: ageDays,
        threshold_days: thresholdDays,
        reason: 'stale',
      });
    }
  }
  freshnessBreaches.sort((a, b) => a.document_path.localeCompare(b.document_path));

  // DA-08: tenant-ingested cards join the weekly cycle. Advisory and
  // fail-open — a broken tenant registry or ledger must never fail the
  // weekly report the rest of the corpus depends on.
  let tenantIngest: TenantIngestCurationSection[] = [];
  try {
    tenantIngest = computeTenantIngestCuration({ config, now });
  } catch {
    tenantIngest = [];
  }
  const tenantIngestFlaggedCount = tenantIngest.reduce(
    (sum, section) => sum + section.flagged.length,
    0
  );

  return {
    generated_at: now.toISOString(),
    config,
    low_yield_hints: lowYieldHints,
    freshness_breaches: freshnessBreaches,
    tenant_ingest: tenantIngest,
    scanned_document_count: docs.length,
    summary: {
      low_yield_count: lowYieldHints.length,
      freshness_breach_count: freshnessBreaches.length,
      tenant_ingest_flagged_count: tenantIngestFlaggedCount,
    },
  };
}

/**
 * Mirrors HINTS.md's presentation contract (`promoted-memory.ts`,
 * `buildLiveHintsDocument`): a generated-header banner + "do not edit
 * manually" note, readable by Recovery/Alignment without a full knowledge
 * search.
 */
export function renderCurationReportMarkdown(report: KnowledgeCurationReport): string {
  const lines: string[] = [
    '# Knowledge Curation Report',
    '',
    '> **Generated by** `pipelines/knowledge-curation-weekly.json` (`wisdom:curation_report`).',
    '> Do not edit manually — content is overwritten by the weekly curation pipeline.',
    '> **Purpose**: effectiveness-driven maintenance candidates for the knowledge_steward —',
    '> low-yield hints and freshness SLO breaches, surfaced here so Recovery and Alignment',
    '> phases can see pending curation without a full knowledge search.',
    '> **Candidates only** — no file is deleted, archived, or demoted automatically.',
    '> KM-03 guardrail: a knowledge_steward must review and approve any demotion by hand.',
    '',
    `generated_at: ${report.generated_at}`,
    `low_yield_delivery_threshold: ${report.config.low_yield_delivery_threshold}`,
    `scanned_document_count: ${report.scanned_document_count}`,
    '',
    '## Low-Yield Hints',
    '',
    `Delivered at least ${report.config.low_yield_delivery_threshold} time(s) with zero recorded uses (KP-05 usage aggregate).`,
    '',
  ];
  if (report.low_yield_hints.length === 0) {
    lines.push('_(none)_');
  } else {
    lines.push(
      '| Document | Delivered | Used | Occurrences | Last Seen |',
      '| --- | --- | --- | --- | --- |'
    );
    for (const hint of report.low_yield_hints) {
      lines.push(
        `| ${hint.document_path} | ${hint.delivered_count} | ${hint.used_count} | ${hint.occurrences} | ${hint.last_seen} |`
      );
    }
  }
  lines.push(
    '',
    '## Freshness SLO Breaches',
    '',
    'Kind-based re-verify deadlines from `knowledge/product/governance/knowledge-curation-slo.json`, applied to frontmatter `last_updated`.',
    ''
  );
  if (report.freshness_breaches.length === 0) {
    lines.push('_(none)_');
  } else {
    lines.push(
      '| Document | Kind | Last Updated | Age (days) | Threshold (days) | Reason |',
      '| --- | --- | --- | --- | --- | --- |'
    );
    for (const breach of report.freshness_breaches) {
      lines.push(
        `| ${breach.document_path} | ${breach.kind} | ${breach.last_updated ?? '_(missing)_'} | ${breach.age_days ?? '—'} | ${breach.threshold_days} | ${breach.reason} |`
      );
    }
  }
  lines.push(
    '',
    '## Tenant Ingest Freshness (DA-08)',
    '',
    'Ingested assets (DA-05 ledger, active versions) whose landed card breaches the freshness SLO for its kind.',
    'Advisory only — a re-ingest is the DA-03/DA-05 sync ceremony’s job, never performed here.',
    ''
  );
  const flaggedSections = report.tenant_ingest.filter((section) => section.flagged.length > 0);
  if (flaggedSections.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const section of flaggedSections) {
      lines.push(
        `### ${section.tenant_slug} (${section.flagged.length} of ${section.active_asset_count} active asset(s))`,
        '',
        '| Asset | Card | Kind | Last Updated | Age (days) | Threshold (days) | Reason |',
        '| --- | --- | --- | --- | --- | --- | --- |'
      );
      for (const entry of section.flagged) {
        lines.push(
          `| ${entry.asset_id} | ${entry.target_path} | ${entry.kind} | ${entry.last_updated ?? '_(missing)_'} | ${entry.age_days ?? '—'} | ${entry.threshold_days} | ${entry.reason} |`
        );
      }
      lines.push('');
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function writeCurationReport(report: KnowledgeCurationReport): { reportPath: string } {
  const filePath = reportPath();
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, renderCurationReportMarkdown(report));
  return { reportPath: filePath };
}

/**
 * Orchestrates compute + write — the single call the actuator op (and the
 * weekly pipeline behind it) uses. `curation_report` in
 * `wisdom-actuator/src/decision-ops.ts` wraps this 1:1.
 */
export function generateKnowledgeCurationReport(options: { now?: Date } = {}): {
  report: KnowledgeCurationReport;
  reportPath: string;
} {
  const report = computeCurationReport(options);
  const { reportPath: writtenPath } = writeCurationReport(report);
  return { report, reportPath: writtenPath };
}

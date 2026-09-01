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
import { getRegisteredEnvText } from '../foundation/env.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { readJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
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
import { listTenantProfileSlugs } from '../tenant-registry.js';
import type { ScopeContext } from '../scope-context.js';
import { physicalScopedPath } from '../physical-namespace.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
} from '../memory-promotion-queue.js';

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

const CURATION_SLO_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/knowledge-curation-slo.schema.json'
);
const curationSloCatalogs = new Map<
  string,
  GovernedCatalog<CurationSloConfig & { version: string }>
>();
const TAXONOMY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/knowledge-taxonomy.schema.json'
);

function safeCurationOverridePath(override: string | undefined, canonical: string): string {
  if (!override) return canonical;
  try {
    return assertSafeRepositoryPath(pathResolver.rootResolve(override), {
      allowMissingLeaf: true,
    });
  } catch {
    return canonical;
  }
}

export interface CurationLowYieldHint {
  document_path: string;
  tenant_slug?: string;
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
  review_by?: string;
  reason: 'stale' | 'review_due' | 'missing_last_updated';
}

export interface CurationArchiveAdvisory {
  document_path: string;
  tenant_slug?: string;
  reason: 'low_yield_and_freshness_breach';
  consecutive_weeks: number;
  first_observed_at: string;
  last_observed_at: string;
}

export interface KnowledgeCurationReport {
  generated_at: string;
  config: CurationSloConfig;
  low_yield_hints: CurationLowYieldHint[];
  /** Low-yield records written before tenant scoping was enforced. */
  legacy_unscoped_hints: CurationLowYieldHint[];
  freshness_breaches: CurationFreshnessBreach[];
  /** Advisory only: requires knowledge_steward ratification before archival. */
  archive_advisories?: CurationArchiveAdvisory[];
  /** DA-08: per-tenant ingested-asset freshness sections (advisory only). */
  tenant_ingest: TenantIngestCurationSection[];
  scanned_document_count: number;
  summary: {
    low_yield_count: number;
    freshness_breach_count: number;
    archive_advisory_count?: number;
    /** DA-08: total flagged ingested assets across tenants. */
    tenant_ingest_flagged_count: number;
  };
}

type ArchiveHistoryEntry = {
  key: string;
  document_path: string;
  tenant_slug?: string;
  consecutive_weeks: number;
  first_observed_at: string;
  last_observed_at: string;
  last_week: string;
};

function sloConfigPath(): string {
  const override = getRegisteredEnvText('KYBERION_CURATION_SLO_CONFIG_PATH')?.trim();
  return safeCurationOverridePath(
    override,
    pathResolver.knowledge('product/governance/knowledge-curation-slo.json')
  );
}

function curationSloCatalog(
  filePath: string
): GovernedCatalog<CurationSloConfig & { version: string }> {
  const cached = curationSloCatalogs.get(filePath);
  if (cached) return cached;
  const catalog = defineCatalog<CurationSloConfig & { version: string }>({
    id: 'knowledge-curation-slo',
    path: filePath,
    schema: CURATION_SLO_SCHEMA_PATH,
    fallback: { version: '1.0.0', ...DEFAULT_SLO_CONFIG },
    fallbackOnInvalid: true,
  });
  curationSloCatalogs.set(filePath, catalog);
  return catalog;
}

function taxonomyPath(): string {
  const override = getRegisteredEnvText('KYBERION_CURATION_TAXONOMY_PATH')?.trim();
  return safeCurationOverridePath(
    override,
    pathResolver.knowledge('product/governance/knowledge-taxonomy.json')
  );
}

function reportPath(): string {
  const override = getRegisteredEnvText('KYBERION_CURATION_REPORT_PATH')?.trim();
  return safeCurationOverridePath(
    override,
    pathResolver.knowledge('product/governance/CURATION_REPORT.md')
  );
}

function archiveHistoryPath(tenantSlug?: string): string {
  if (tenantSlug) {
    return assertSafeRepositoryPath(
      pathResolver.rootResolve(
        physicalScopedPath(
          'active/shared/runtime/feedback-loop',
          { tier: 'confidential', tenant_slug: tenantSlug, scope_kind: 'tenant' },
          'curation-archive-history.json'
        )
      ),
      { allowMissingLeaf: true }
    );
  }
  const override = getRegisteredEnvText('KYBERION_CURATION_ARCHIVE_HISTORY_PATH')?.trim();
  return safeCurationOverridePath(
    override,
    pathResolver.shared('runtime/feedback-loop/curation-archive-history.json')
  );
}

/** Physical archive-history location used by the weekly steward report. */
export function knowledgeCurationArchiveHistoryPath(tenantSlug?: string): string {
  return archiveHistoryPath(tenantSlug);
}

function weekKey(now: Date): string {
  const day = now.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getTime() + mondayOffset * MS_PER_DAY);
  return monday.toISOString().slice(0, 10);
}

function readArchiveHistory(tenantSlug?: string): ArchiveHistoryEntry[] {
  const filePath = archiveHistoryPath(tenantSlug);
  if (!safeExistsSync(filePath)) return [];
  try {
    const parsed = readJson<unknown>(filePath);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ArchiveHistoryEntry =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as ArchiveHistoryEntry).key === 'string' &&
        typeof (entry as ArchiveHistoryEntry).last_week === 'string'
    );
  } catch {
    return [];
  }
}

function archiveCandidatesFromReport(
  report: Pick<KnowledgeCurationReport, 'low_yield_hints' | 'freshness_breaches'>,
  now: Date,
  history: ArchiveHistoryEntry[]
): CurationArchiveAdvisory[] {
  const freshnessPaths = new Set(report.freshness_breaches.map((entry) => entry.document_path));
  const currentWeek = weekKey(now);
  const priorByKey = new Map(history.map((entry) => [entry.key, entry]));
  return report.low_yield_hints
    .filter((hint) => freshnessPaths.has(hint.document_path))
    .map((hint) => {
      const key = `${hint.tenant_slug || 'unscoped'}:${hint.document_path}`;
      const prior = priorByKey.get(key);
      if (!prior || prior.last_week === currentWeek) return undefined;
      const elapsed = now.getTime() - Date.parse(prior.last_observed_at);
      if (!Number.isFinite(elapsed) || elapsed < 6 * MS_PER_DAY || elapsed > 14 * MS_PER_DAY) {
        return undefined;
      }
      return {
        document_path: hint.document_path,
        ...(hint.tenant_slug ? { tenant_slug: hint.tenant_slug } : {}),
        reason: 'low_yield_and_freshness_breach' as const,
        consecutive_weeks: prior.consecutive_weeks + 1,
        first_observed_at: prior.first_observed_at,
        last_observed_at: now.toISOString(),
      };
    })
    .filter((entry): entry is CurationArchiveAdvisory => Boolean(entry))
    .filter((entry) => entry.consecutive_weeks >= 2)
    .sort((a, b) =>
      `${a.tenant_slug || 'unscoped'}:${a.document_path}`.localeCompare(
        `${b.tenant_slug || 'unscoped'}:${b.document_path}`
      )
    );
}

function observeArchiveHistory(
  report: Pick<KnowledgeCurationReport, 'low_yield_hints' | 'freshness_breaches'>,
  now: Date
): CurationArchiveAdvisory[] {
  const tenantKeys = new Set([
    '',
    ...registeredKnowledgeTenants(),
    ...report.low_yield_hints.map((hint) => hint.tenant_slug || ''),
  ]);
  const advisories: CurationArchiveAdvisory[] = [];
  for (const tenantKey of tenantKeys) {
    const tenantSlug = tenantKey || undefined;
    const lowYieldHints = report.low_yield_hints.filter(
      (hint) => (hint.tenant_slug || '') === tenantKey
    );
    const documentPaths = new Set(lowYieldHints.map((hint) => hint.document_path));
    const scopedReport = {
      low_yield_hints: lowYieldHints,
      freshness_breaches: report.freshness_breaches.filter((breach) =>
        documentPaths.has(breach.document_path)
      ),
    };
    const history = readArchiveHistory(tenantSlug);
    const currentWeek = weekKey(now);
    const priorByKey = new Map(history.map((entry) => [entry.key, entry]));
    const candidates = scopedReport.low_yield_hints.filter((hint) =>
      scopedReport.freshness_breaches.some((breach) => breach.document_path === hint.document_path)
    );
    const nextHistory = new Map<string, ArchiveHistoryEntry>();
    for (const hint of candidates) {
      const key = `${hint.tenant_slug || 'unscoped'}:${hint.document_path}`;
      const prior = priorByKey.get(key);
      const elapsed = prior ? now.getTime() - Date.parse(prior.last_observed_at) : NaN;
      const consecutiveWeeks =
        prior &&
        prior.last_week !== currentWeek &&
        Number.isFinite(elapsed) &&
        elapsed >= 6 * MS_PER_DAY &&
        elapsed <= 14 * MS_PER_DAY
          ? prior.consecutive_weeks + 1
          : prior?.last_week === currentWeek
            ? prior.consecutive_weeks
            : 1;
      nextHistory.set(key, {
        key,
        document_path: hint.document_path,
        ...(hint.tenant_slug ? { tenant_slug: hint.tenant_slug } : {}),
        consecutive_weeks: consecutiveWeeks,
        first_observed_at: prior?.first_observed_at || now.toISOString(),
        last_observed_at: now.toISOString(),
        last_week: currentWeek,
      });
    }
    const historyPath = archiveHistoryPath(tenantSlug);
    const parent = path.dirname(historyPath);
    if (!safeExistsSync(parent)) safeMkdir(parent, { recursive: true });
    safeWriteFile(historyPath, JSON.stringify([...nextHistory.values()], null, 2) + '\n');
    advisories.push(...archiveCandidatesFromReport(scopedReport, now, history));
  }
  return advisories;
}

export function knowledgeCurationSloConfigPath(): string {
  return sloConfigPath();
}

export function knowledgeCurationReportPath(): string {
  return reportPath();
}

function registeredKnowledgeTenants(): string[] {
  try {
    return listTenantProfileSlugs();
  } catch {
    return [];
  }
}

function usageScopeForTenant(tenantSlug: string): ScopeContext {
  return { tier: 'confidential', tenant_slug: tenantSlug };
}

/**
 * SLO thresholds are config, not code: this is the only place defaults are
 * declared, and they are used only when the config file is absent/invalid
 * (fail-open — a missing/malformed config must not crash the weekly
 * pipeline, it should just fall back to conservative defaults).
 */
export function loadCurationSloConfig(): CurationSloConfig {
  const filePath = sloConfigPath();
  try {
    const parsed = curationSloCatalog(filePath).load();
    return {
      low_yield_delivery_threshold: parsed.low_yield_delivery_threshold,
      freshness_days_by_kind: { ...parsed.freshness_days_by_kind },
      default_freshness_days: parsed.default_freshness_days,
    };
  } catch {
    return { ...DEFAULT_SLO_CONFIG };
  }
}

interface TaxonomyDirectoryDefault {
  path_prefix: string;
  kind: string;
}

interface TaxonomyCatalogPayload {
  version: string;
  directory_defaults?: TaxonomyDirectoryDefault[];
}

const taxonomyCatalogs = new Map<string, GovernedCatalog<TaxonomyCatalogPayload>>();

function taxonomyCatalog(filePath: string): GovernedCatalog<TaxonomyCatalogPayload> {
  const cached = taxonomyCatalogs.get(filePath);
  if (cached) return cached;
  const catalog = defineCatalog<TaxonomyCatalogPayload>({
    id: 'knowledge-taxonomy',
    path: filePath,
    schema: TAXONOMY_SCHEMA_PATH,
  });
  taxonomyCatalogs.set(filePath, catalog);
  return catalog;
}

function loadTaxonomyDirectoryDefaults(): TaxonomyDirectoryDefault[] {
  const filePath = taxonomyPath();
  try {
    const parsed = taxonomyCatalog(filePath).load();
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
  const override = getRegisteredEnvText('KYBERION_CURATION_SCAN_ROOTS')?.trim();
  const roots = override
    ? override
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : loadTaxonomyDirectoryDefaults().map((entry) => entry.path_prefix);
  return roots.flatMap((root) => {
    try {
      return [
        assertSafeRepositoryPath(pathResolver.rootResolve(root), {
          allowMissingLeaf: true,
        }),
      ];
    } catch {
      return [];
    }
  });
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
  review_by?: string;
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
    let fullPath: string;
    try {
      fullPath = assertSafeRepositoryPath(path.join(root, entry));
    } catch {
      continue;
    }
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
    const reviewBy = extractFrontmatterValue(content, 'review_by');
    out.push({
      document_path: relSource,
      kind,
      ...(lastUpdated ? { last_updated: lastUpdated } : {}),
      ...(reviewBy ? { review_by: reviewBy } : {}),
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

  const toLowYield = (
    entry: ReturnType<typeof loadKnowledgeUsageAggregate>[number],
    tenantSlug?: string
  ): CurationLowYieldHint | undefined => {
    if (entry.delivered_count < config.low_yield_delivery_threshold || entry.used_count !== 0) {
      return undefined;
    }
    return {
      document_path: entry.document_path,
      ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
      delivered_count: entry.delivered_count,
      used_count: entry.used_count,
      occurrences: entry.occurrences,
      last_seen: entry.last_seen,
    };
  };
  const legacyUnscopedHints = loadKnowledgeUsageAggregate()
    .map((entry) => toLowYield(entry))
    .filter((entry): entry is CurationLowYieldHint => Boolean(entry))
    .sort((a, b) => a.document_path.localeCompare(b.document_path));
  const tenantHints = registeredKnowledgeTenants().flatMap((tenantSlug) =>
    loadKnowledgeUsageAggregate(usageScopeForTenant(tenantSlug))
      .map((entry) => toLowYield(entry, tenantSlug))
      .filter((entry): entry is CurationLowYieldHint => Boolean(entry))
  );
  const lowYieldHints = [...legacyUnscopedHints, ...tenantHints].sort((a, b) =>
    `${a.tenant_slug || 'unscoped'}:${a.document_path}`.localeCompare(
      `${b.tenant_slug || 'unscoped'}:${b.document_path}`
    )
  );

  const directoryDefaults = loadTaxonomyDirectoryDefaults();
  const docs: ScannedDoc[] = [];
  for (const root of scanRoots()) {
    scanMarkdownDocs(root, directoryDefaults, docs);
  }

  const freshnessBreaches: CurationFreshnessBreach[] = [];
  for (const doc of docs) {
    const thresholdDays = config.freshness_days_by_kind[doc.kind] ?? config.default_freshness_days;
    const reviewByMs = doc.review_by ? Date.parse(doc.review_by) : NaN;
    if (Number.isFinite(reviewByMs) && reviewByMs < now.getTime()) {
      freshnessBreaches.push({
        document_path: doc.document_path,
        kind: doc.kind,
        last_updated: doc.last_updated ?? null,
        review_by: doc.review_by,
        age_days: Math.floor((now.getTime() - reviewByMs) / MS_PER_DAY),
        threshold_days: 0,
        reason: 'review_due',
      });
      continue;
    }
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
  const archiveAdvisories = archiveCandidatesFromReport(
    { low_yield_hints: lowYieldHints, freshness_breaches: freshnessBreaches },
    now,
    readArchiveHistory()
  );

  return {
    generated_at: now.toISOString(),
    config,
    low_yield_hints: lowYieldHints,
    legacy_unscoped_hints: legacyUnscopedHints,
    freshness_breaches: freshnessBreaches,
    archive_advisories: archiveAdvisories,
    tenant_ingest: tenantIngest,
    scanned_document_count: docs.length,
    summary: {
      low_yield_count: lowYieldHints.length,
      freshness_breach_count: freshnessBreaches.length,
      archive_advisory_count: archiveAdvisories.length,
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
    `legacy_unscoped_hint_count: ${(report.legacy_unscoped_hints || []).length}`,
    `archive_advisory_count: ${(report.archive_advisories || []).length}`,
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
      '| Tenant | Document | Delivered | Used | Occurrences | Last Seen |',
      '| --- | --- | --- | --- | --- | --- |'
    );
    for (const hint of report.low_yield_hints) {
      lines.push(
        `| ${hint.tenant_slug || 'unscoped-legacy'} | ${hint.document_path} | ${hint.delivered_count} | ${hint.used_count} | ${hint.occurrences} | ${hint.last_seen} |`
      );
    }
  }
  lines.push(
    '',
    '## Archive Advisories',
    '',
    'Two consecutive weekly observations of low-yield plus freshness-breach evidence are required. A knowledge_steward must ratify archival; this report never deletes or moves a document.',
    ''
  );
  if ((report.archive_advisories || []).length === 0) {
    lines.push('_(none)_');
  } else {
    lines.push(
      '| Tenant | Document | Consecutive weeks | First observed | Last observed |',
      '| --- | --- | --- | --- | --- |'
    );
    for (const advisory of report.archive_advisories) {
      lines.push(
        `| ${advisory.tenant_slug || 'unscoped-legacy'} | ${advisory.document_path} | ${advisory.consecutive_weeks} | ${advisory.first_observed_at} | ${advisory.last_observed_at} |`
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
  const now = options.now || new Date();
  const report = computeCurationReport({ now });
  const observedAdvisories = observeArchiveHistory(report, now);
  const reportWithAdvisories: KnowledgeCurationReport = {
    ...report,
    archive_advisories: observedAdvisories,
    summary: {
      ...report.summary,
      archive_advisory_count: observedAdvisories.length,
    },
  };
  for (const advisory of observedAdvisories) {
    enqueueMemoryPromotionCandidate(
      createMemoryPromotionCandidate({
        sourceType: 'artifact',
        sourceRef: `curation:${advisory.tenant_slug || 'unscoped'}:${advisory.document_path}`,
        proposedMemoryKind: 'archive_advisory',
        summary: `Review ${advisory.document_path} for archival after ${advisory.consecutive_weeks} consecutive weekly low-yield and freshness-breach observations.`,
        evidenceRefs: [advisory.document_path, 'knowledge/product/governance/CURATION_REPORT.md'],
        sensitivityTier: advisory.tenant_slug ? 'confidential' : 'personal',
        ...(advisory.tenant_slug
          ? { scope: { tier: 'confidential' as const, tenant_slug: advisory.tenant_slug } }
          : {}),
      })
    );
  }
  const { reportPath: writtenPath } = writeCurationReport(reportWithAdvisories);
  return { report: reportWithAdvisories, reportPath: writtenPath };
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  computeCurationReport,
  generateKnowledgeCurationReport,
  knowledgeCurationArchiveHistoryPath,
  loadCurationSloConfig,
  renderCurationReportMarkdown,
  writeCurationReport,
} from './knowledge-curation-report.js';
import type { KnowledgeUsageAggregateEntry } from './knowledge-feedback-loop.js';
import { validatePipelineAdf } from '../pipeline-contract.js';
import AjvModule from 'ajv';
import { compileSchemaFromPath } from '../schema-loader.js';

// Hermetic isolation — same convention as KP-05's knowledge-feedback-loop.test.ts:
// point every path this module touches at a unique per-process tmp root so this
// suite never reads/writes the real active/shared or knowledge/product files.
const suiteRoot = pathResolver.sharedTmp(`kp06-knowledge-curation-report-test/${process.pid}`);
const usagePathOverride = `${suiteRoot}/knowledge-usage/usage.json`;
const sloConfigPathOverride = `${suiteRoot}/knowledge-curation-slo.json`;
const scanRootOverride = `${suiteRoot}/corpus`;
const reportPathOverride = `${suiteRoot}/CURATION_REPORT.md`;
const archiveHistoryPathOverride = `${suiteRoot}/curation-archive-history.json`;
const queuePathOverride = `${suiteRoot}/promotion-queue.jsonl`;

const envKeys = [
  'KYBERION_KNOWLEDGE_USAGE_PATH',
  'KYBERION_CURATION_SLO_CONFIG_PATH',
  'KYBERION_CURATION_SCAN_ROOTS',
  'KYBERION_CURATION_REPORT_PATH',
  'KYBERION_CURATION_ARCHIVE_HISTORY_PATH',
  'KYBERION_MEMORY_QUEUE_PATH',
] as const;
const originalEnv: Record<string, string | undefined> = {};

function writeUsageFixture(entries: KnowledgeUsageAggregateEntry[]): void {
  const filePath = pathResolver.rootResolve(usagePathOverride);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(entries, null, 2));
}

function writeSloConfigFixture(config: Record<string, unknown>): void {
  const filePath = pathResolver.rootResolve(sloConfigPathOverride);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(config, null, 2));
}

function writeCorpusDoc(relFile: string, content: string): void {
  const filePath = pathResolver.rootResolve(`${scanRootOverride}/${relFile}`);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, content);
}

beforeEach(() => {
  for (const key of envKeys) originalEnv[key] = process.env[key];
  process.env.KYBERION_KNOWLEDGE_USAGE_PATH = usagePathOverride;
  process.env.KYBERION_CURATION_SLO_CONFIG_PATH = sloConfigPathOverride;
  process.env.KYBERION_CURATION_SCAN_ROOTS = scanRootOverride;
  process.env.KYBERION_CURATION_REPORT_PATH = reportPathOverride;
  process.env.KYBERION_CURATION_ARCHIVE_HISTORY_PATH = archiveHistoryPathOverride;
  process.env.KYBERION_MEMORY_QUEUE_PATH = queuePathOverride;
  safeRmSync(suiteRoot, { recursive: true, force: true });
});

afterEach(() => {
  safeRmSync(suiteRoot, { recursive: true, force: true });
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const NOW = new Date('2026-07-25T00:00:00.000Z');

describe('computeCurationReport — low-yield hints', () => {
  it('keeps tenant archive history outside the global archive override', () => {
    const tenantPath = knowledgeCurationArchiveHistoryPath('tenant-a');
    expect(tenantPath).toContain(
      '/active/shared/runtime/feedback-loop/tenants/tenant-a/curation-archive-history.json'
    );
    expect(tenantPath).not.toBe(pathResolver.rootResolve(archiveHistoryPathOverride));
  });

  it('flags a document delivered >= threshold times with zero recorded uses', () => {
    writeUsageFixture([
      {
        document_path: 'knowledge/product/architecture/foo.md',
        delivered_count: 5,
        used_count: 0,
        not_used_count: 3,
        occurrences: 5,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);

    const report = computeCurationReport({ now: NOW });
    expect(report.low_yield_hints).toEqual([
      {
        document_path: 'knowledge/product/architecture/foo.md',
        delivered_count: 5,
        used_count: 0,
        occurrences: 5,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);
    expect(report.summary.low_yield_count).toBe(1);
  });

  it('excludes documents below the delivery threshold or with at least one use', () => {
    writeUsageFixture([
      {
        document_path: 'knowledge/product/below-threshold.md',
        delivered_count: 4,
        used_count: 0,
        not_used_count: 4,
        occurrences: 4,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
      {
        document_path: 'knowledge/product/well-used.md',
        delivered_count: 10,
        used_count: 2,
        not_used_count: 8,
        occurrences: 10,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);

    const report = computeCurationReport({ now: NOW });
    expect(report.low_yield_hints).toEqual([]);
  });
});

describe('computeCurationReport — freshness SLO breaches', () => {
  it('flags a governance doc older than its kind threshold (default config: 90 days)', () => {
    writeCorpusDoc(
      'stale-governance.md',
      ['---', 'kind: governance', 'last_updated: 2026-01-01', '---', '', '# Stale'].join('\n')
    );

    const report = computeCurationReport({ now: NOW });
    expect(report.freshness_breaches).toEqual([
      {
        document_path: expect.stringContaining('stale-governance.md'),
        kind: 'governance',
        last_updated: '2026-01-01',
        age_days: expect.any(Number),
        threshold_days: 90,
        reason: 'stale',
      },
    ]);
    expect(report.freshness_breaches[0]?.age_days).toBeGreaterThan(90);
  });

  it('does not flag a playbook doc within its 60-day threshold', () => {
    writeCorpusDoc(
      'fresh-playbook.md',
      ['---', 'kind: playbook', 'last_updated: 2026-07-01', '---', '', '# Fresh'].join('\n')
    );

    const report = computeCurationReport({ now: NOW });
    expect(report.freshness_breaches).toEqual([]);
    expect(report.scanned_document_count).toBe(1);
  });

  it('flags a doc with no last_updated frontmatter as missing_last_updated', () => {
    writeCorpusDoc(
      'no-date.md',
      ['---', 'kind: knowledge_hint', '---', '', '# No date'].join('\n')
    );

    const report = computeCurationReport({ now: NOW });
    expect(report.freshness_breaches).toEqual([
      expect.objectContaining({ reason: 'missing_last_updated', kind: 'knowledge_hint' }),
    ]);
  });

  it('excludes a doc with no declared or inferable kind entirely', () => {
    writeCorpusDoc('no-kind.md', ['# Untyped doc', '', 'no frontmatter at all'].join('\n'));

    const report = computeCurationReport({ now: NOW });
    expect(report.scanned_document_count).toBe(0);
    expect(report.freshness_breaches).toEqual([]);
  });
});

describe('computeCurationReport — SLO thresholds come from config', () => {
  it('produces a different breach set when the SLO config fixture changes', () => {
    writeCorpusDoc(
      'medium-age-playbook.md',
      ['---', 'kind: playbook', 'last_updated: 2026-05-01', '---', '', '# Medium age'].join('\n')
    );

    // Default config: playbook threshold 60 days. 2026-05-01 → 2026-07-25 is ~85 days: breach.
    const defaultReport = computeCurationReport({ now: NOW });
    expect(defaultReport.freshness_breaches).toHaveLength(1);
    expect(defaultReport.config.freshness_days_by_kind.playbook).toBe(60);

    // Widen the playbook threshold to 120 days via a config fixture: no longer a breach.
    writeSloConfigFixture({
      version: '1.0.0',
      low_yield_delivery_threshold: 5,
      freshness_days_by_kind: { governance: 90, playbook: 120, knowledge_hint: 30 },
      default_freshness_days: 180,
    });
    const widenedReport = computeCurationReport({ now: NOW });
    expect(widenedReport.config.freshness_days_by_kind.playbook).toBe(120);
    expect(widenedReport.freshness_breaches).toEqual([]);
  });

  it('falls back to built-in defaults when no config file exists', () => {
    const config = loadCurationSloConfig();
    expect(config).toEqual({
      low_yield_delivery_threshold: 5,
      freshness_days_by_kind: { governance: 90, playbook: 60, knowledge_hint: 30 },
      default_freshness_days: 180,
    });
  });
});

describe('computeCurationReport — determinism', () => {
  it('produces identical output (aside from generated_at) across repeated calls on unchanged input', () => {
    writeUsageFixture([
      {
        document_path: 'knowledge/product/foo.md',
        delivered_count: 6,
        used_count: 0,
        not_used_count: 6,
        occurrences: 6,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);
    writeCorpusDoc(
      'stale.md',
      ['---', 'kind: governance', 'last_updated: 2026-01-01', '---'].join('\n')
    );
    const first = computeCurationReport({ now: NOW });
    const second = computeCurationReport({ now: NOW });
    expect(second).toEqual(first);
  });
});

describe('writeCurationReport / generateKnowledgeCurationReport', () => {
  it('writes deterministic markdown matching renderCurationReportMarkdown to the configured report path', () => {
    writeUsageFixture([
      {
        document_path: 'knowledge/product/foo.md',
        delivered_count: 5,
        used_count: 0,
        not_used_count: 5,
        occurrences: 5,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);
    writeCorpusDoc(
      'stale.md',
      ['---', 'kind: governance', 'last_updated: 2026-01-01', '---'].join('\n')
    );

    const report = computeCurationReport({ now: NOW });
    const { reportPath } = writeCurationReport(report);

    expect(reportPath).toBe(pathResolver.rootResolve(reportPathOverride));
    expect(safeExistsSync(reportPath)).toBe(true);
    const written = safeReadFile(reportPath, { encoding: 'utf8' }) as string;
    expect(written).toBe(renderCurationReportMarkdown(report));
    expect(written).toContain('Low-Yield Hints');
    expect(written).toContain('Freshness SLO Breaches');
    expect(written).toContain('knowledge/product/foo.md');
    expect(written.toLowerCase()).toContain('candidates only');
    expect(written.toLowerCase()).toContain('do not edit manually');
  });

  it('generateKnowledgeCurationReport computes and persists in one call', () => {
    writeCorpusDoc(
      'stale.md',
      ['---', 'kind: governance', 'last_updated: 2026-01-01', '---'].join('\n')
    );
    const { report, reportPath } = generateKnowledgeCurationReport({ now: NOW });
    expect(report.freshness_breaches).toHaveLength(1);
    expect(safeExistsSync(reportPath)).toBe(true);
  });

  it('queues an archive advisory only after two weekly low-yield and freshness observations', () => {
    writeUsageFixture([
      {
        document_path: 'knowledge/product/foo.md',
        delivered_count: 5,
        used_count: 0,
        not_used_count: 5,
        occurrences: 5,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);
    writeCorpusDoc(
      'stale.md',
      ['---', 'kind: governance', 'last_updated: 2026-01-01', '---'].join('\n')
    );
    const staleDocumentPath = path
      .relative(pathResolver.rootDir(), pathResolver.rootResolve(`${scanRootOverride}/stale.md`))
      .replace(/\\/g, '/');

    const first = generateKnowledgeCurationReport({ now: NOW });
    expect(first.report.archive_advisories).toEqual([]);
    const second = generateKnowledgeCurationReport({
      now: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    expect(second.report.archive_advisories).toEqual([]);

    // The usage path and stale document must refer to the same document for
    // the intersection to become an archive advisory.
    writeUsageFixture([
      {
        document_path: staleDocumentPath,
        delivered_count: 5,
        used_count: 0,
        not_used_count: 5,
        occurrences: 5,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);
    generateKnowledgeCurationReport({ now: NOW });
    const third = generateKnowledgeCurationReport({
      now: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    expect(third.report.archive_advisories).toHaveLength(1);
    expect(third.report.archive_advisories[0]).toMatchObject({
      document_path: staleDocumentPath,
      consecutive_weeks: 2,
    });
  });

  it('never touches usage/promotion state — the report is read-only over KP-05 data', () => {
    writeUsageFixture([
      {
        document_path: 'knowledge/product/foo.md',
        delivered_count: 5,
        used_count: 0,
        not_used_count: 5,
        occurrences: 5,
        last_seen: '2026-07-01T00:00:00.000Z',
      },
    ]);
    const usagePath = pathResolver.rootResolve(usagePathOverride);
    const before = safeReadFile(usagePath, { encoding: 'utf8' });
    computeCurationReport({ now: NOW });
    const after = safeReadFile(usagePath, { encoding: 'utf8' });
    expect(after).toEqual(before);
  });
});

describe('pipelines/knowledge-curation-weekly.json', () => {
  it('validates against the pipeline ADF schema and wires the typed op on a weekly schedule', () => {
    const filePath = pathResolver.rootResolve('pipelines/knowledge-curation-weekly.json');
    const raw = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);

    const adf = validatePipelineAdf(raw);
    expect(adf.schedule?.cron).toBe('0 3 * * 0');
    expect(adf.schedule?.timezone).toBe('Asia/Tokyo');
    expect(adf.schedule?.enabled).toBe(true);
    expect(adf.steps.some((step) => step.op === 'wisdom:curation_report')).toBe(true);
  });
});

describe('knowledge-curation-slo.json config file', () => {
  it('the committed default config parses to the same defaults computeCurationReport falls back to', () => {
    const filePath = pathResolver.knowledge('product/governance/knowledge-curation-slo.json');
    const raw = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
    expect(raw.low_yield_delivery_threshold).toBe(5);
    expect(raw.freshness_days_by_kind).toEqual({
      governance: 90,
      playbook: 60,
      knowledge_hint: 30,
      // DA-08: ingested cards (typically kind: reference) join the SLO cycle.
      reference: 120,
    });
    expect(raw.default_freshness_days).toBe(180);
  });

  it('validates against knowledge-curation-slo.schema.json', () => {
    const Ajv = (AjvModule as any).default ?? AjvModule;
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/knowledge-curation-slo.schema.json')
    );
    const raw = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/governance/knowledge-curation-slo.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(validate(raw)).toBe(true);
  });
});

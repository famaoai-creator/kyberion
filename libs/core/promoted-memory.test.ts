import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createDistillCandidateRecord } from './distill-candidate-registry.js';
import {
  buildPromotedMemoryRecord,
  savePromotedMemoryRecord,
  isMeaningfulPromotionCandidate,
  NotMeaningfulPromotionCandidateError,
} from './promoted-memory.js';
import {
  resolvePromotedReportAudience,
  resolvePromotedReportOutputFormat,
  resolvePromotedReportTemplateSections,
} from './promoted-report-template-policy.js';
import { safeReadFile } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { buildOrganizationWorkLoopSummary } from './work-design.js';
import { safeWriteFile } from './secure-io.js';

// Files written during a single test run; cleaned up in afterEach so the
// committed knowledge/public/common/.../generated/ directory does not
// accumulate fixture-shaped records on every CI run.
const writtenPaths: string[] = [];
const archivedPaths: string[] = [];
function rememberWrite(absMdPath: string): void {
  writtenPaths.push(absMdPath);
  writtenPaths.push(absMdPath.replace(/\.md$/, '.json'));
}

function rememberArchive(absPath: string): void {
  archivedPaths.push(absPath);
}

describe('promoted-memory', () => {
  const hintsPath = pathResolver.knowledge('product/governance/HINTS.md');
  let originalHintsRaw: string | null = null;

  const scratchHintsDir = pathResolver.shared('tmp/tests/promoted-memory-hints');
  const scratchHintsPath = `${scratchHintsDir}/HINTS.md`;

  beforeAll(() => {
    if (fs.existsSync(hintsPath)) {
      originalHintsRaw = safeReadFile(hintsPath, { encoding: 'utf8' }) as string;
    }
    // Isolate rotation to a scratch copy so parallel suites never observe a
    // mid-test dirty knowledge tree (see mission-distill.test.ts).
    fs.mkdirSync(scratchHintsDir, { recursive: true });
    fs.writeFileSync(scratchHintsPath, originalHintsRaw ?? '');
    process.env.KYBERION_HINTS_PATH = scratchHintsPath;
    process.env.KYBERION_HINTS_ARCHIVE_DIR = `${scratchHintsDir}/archive`;
  });

  afterEach(() => {
    for (const p of writtenPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {
        /* best-effort */
      }
    }
    writtenPaths.length = 0;
    for (const p of archivedPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {
        /* best-effort */
      }
    }
    archivedPaths.length = 0;
  });

  afterAll(() => {
    delete process.env.KYBERION_HINTS_PATH;
    delete process.env.KYBERION_HINTS_ARCHIVE_DIR;
    fs.rmSync(scratchHintsDir, { recursive: true, force: true });
    if (originalHintsRaw !== null) {
      if (!fs.existsSync(hintsPath)) {
        withExecutionContext('ecosystem_architect', () => {
          safeWriteFile(hintsPath, originalHintsRaw);
        });
      }
      return;
    }
    if (fs.existsSync(hintsPath)) {
      withExecutionContext('ecosystem_architect', () => {
        fs.unlinkSync(hintsPath);
      });
    }
  });

  it('builds a tier-aware promoted memory record', () => {
    const workLoop = buildOrganizationWorkLoopSummary({
      intentId: 'inspect-service',
      taskType: 'service_operation',
      shape: 'mission',
      tier: 'confidential',
      outcomeIds: ['service_summary'],
      requiresApproval: true,
    });
    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'confidential',
      title: 'Reusable SOP candidate',
      summary: 'Operational handling should be reusable.',
      status: 'promoted',
      target_kind: 'sop_candidate',
      work_loop: workLoop,
    });
    const record = buildPromotedMemoryRecord(candidate);
    expect(record.kind).toBe('sop_candidate');
    expect(record.tier).toBe('confidential');
    if (record.kind !== 'sop_candidate') throw new Error('expected sop_candidate');
    expect(record.procedure_steps.length).toBeGreaterThan(0);
    expect(record.safety_notes.length).toBeGreaterThan(0);
    // Explicit shape hint wins — inferExecutionShape honors it verbatim
    // (work-design.ts commit 80f40d53 made caller intent authoritative).
    expect(record.work_loop?.resolution.execution_shape).toBe('mission');
  });

  it('builds kind-specific records from metadata', () => {
    const hintCandidate = createDistillCandidateRecord({
      source_type: 'artifact',
      tier: 'public',
      title: 'Browser hint',
      summary: 'Use the browser operator for repeatable site navigation.',
      status: 'promoted',
      target_kind: 'knowledge_hint',
      specialist_id: 'browser-operator',
      metadata: {
        hint_scope: 'browser navigation',
        hint_triggers: ['open site', 'go to page'],
        recommended_refs: ['knowledge/public/procedures/browser/navigate-web.md'],
      },
    });
    const record = buildPromotedMemoryRecord(hintCandidate);
    expect(record.kind).toBe('knowledge_hint');
    if (record.kind !== 'knowledge_hint') throw new Error('expected knowledge_hint');
    expect(record.hint_scope).toBe('browser navigation');
    expect(record.hint_triggers).toContain('open site');
    expect(record.recommended_refs[0]).toContain('navigate-web.md');
  });

  it('uses the promoted report template policy defaults when metadata is absent', () => {
    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'public',
      title: 'Report template',
      summary: 'Reusable report layout candidate.',
      status: 'promoted',
      target_kind: 'report_template',
    });
    const record = buildPromotedMemoryRecord(candidate);
    expect(record.kind).toBe('report_template');
    if (record.kind !== 'report_template') throw new Error('expected report_template');
    expect(record.template_sections).toEqual(resolvePromotedReportTemplateSections());
    expect(record.audience).toBe(resolvePromotedReportAudience());
    expect(record.output_format).toBe(resolvePromotedReportOutputFormat());
  });

  it('writes structured json and markdown outputs with kind-specific sections', () => {
    // Use a non-TEST track so the value threshold accepts the candidate.
    // The afterEach hook cleans up the .json + .md so the committed
    // generated/ directory stays clean.
    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'public',
      track_id: 'TRK-DEMO-PROMOTE-WRITE',
      track_name: 'Promote-write demo',
      title: 'Customer-facing presentation pattern',
      summary: 'Recurring deck-style update for the weekly stakeholder review.',
      status: 'promoted',
      target_kind: 'pattern',
      artifact_ids: ['ART-1'],
      evidence_refs: ['artifact:ART-1'],
      metadata: {
        applicability: ['presentation delivery', 'document specialist'],
        reusable_steps: ['Review the prior deck', 'Adapt the structure', 'Validate the output'],
        expected_outcome: 'A reusable presentation artifact.',
      },
    });
    const saved = savePromotedMemoryRecord(candidate, { executionRole: 'chronos_gateway' });
    rememberWrite(pathResolver.resolve(saved.logicalPath));
    expect(saved.logicalPath).toContain('knowledge/public/common/patterns/generated/');
    expect(saved.record.record_id).toBe(candidate.candidate_id);
    expect(saved.record.kind).toBe('pattern');
    expect(saved.record.track_id).toBe('TRK-DEMO-PROMOTE-WRITE');
    if (saved.record.kind !== 'pattern') throw new Error('expected pattern');
    expect(saved.record.applicability).toContain('presentation delivery');
    const markdownPath = pathResolver.resolve(saved.logicalPath);
    const markdown = safeReadFile(markdownPath, { encoding: 'utf8' }) as string;
    expect(markdown).toContain('## Applicability');
    expect(markdown).toContain('## Reusable Steps');
    expect(markdown).toContain('A reusable presentation artifact.');
  });

  it('records supersede relationships in frontmatter and backfills the prior record', () => {
    const previousCandidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'public',
      track_id: 'TRK-DEMO-SUPERSEDE-OLD',
      title: 'Legacy presentation pattern',
      summary: 'Earlier pattern that should be superseded by the revised version.',
      status: 'promoted',
      target_kind: 'pattern',
      evidence_refs: ['artifact:ART-OLD'],
      metadata: {
        applicability: ['presentation delivery'],
        reusable_steps: ['Review the prior deck'],
        expected_outcome: 'A reusable legacy presentation artifact.',
      },
    });
    const previous = savePromotedMemoryRecord(previousCandidate, {
      executionRole: 'chronos_gateway',
    });
    rememberWrite(pathResolver.resolve(previous.logicalPath));

    const nextCandidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'public',
      track_id: 'TRK-DEMO-SUPERSEDE-NEW',
      title: 'Revised presentation pattern',
      summary: 'Updated pattern that supersedes the older guidance.',
      status: 'promoted',
      target_kind: 'pattern',
      evidence_refs: ['artifact:ART-NEW'],
      metadata: {
        applicability: ['presentation delivery'],
        reusable_steps: ['Review the latest deck'],
        expected_outcome: 'A reusable revised presentation artifact.',
        supersedes: previous.logicalPath,
      },
    });
    const next = savePromotedMemoryRecord(nextCandidate, { executionRole: 'chronos_gateway' });
    rememberWrite(pathResolver.resolve(next.logicalPath));

    const nextMarkdown = safeReadFile(pathResolver.resolve(next.logicalPath), {
      encoding: 'utf8',
    }) as string;
    const previousMarkdown = safeReadFile(pathResolver.resolve(previous.logicalPath), {
      encoding: 'utf8',
    }) as string;
    expect(nextMarkdown).toContain(`supersedes: ${previous.logicalPath}`);
    expect(previousMarkdown).toContain(`superseded_by: ${nextCandidate.candidate_id}`);
  });

  it('appends promoted knowledge hints into governance HINTS.md', () => {
    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'personal',
      track_id: 'TRK-DEMO-HINTS',
      track_name: 'Hints demo',
      title: 'Browser hint for repeatable navigation',
      summary: 'Use the browser bridge when a workflow depends on deterministic site navigation.',
      status: 'promoted',
      target_kind: 'knowledge_hint',
      evidence_refs: ['active/shared/tmp/hints-source.md'],
      metadata: {
        hint_scope: 'browser navigation',
        hint_triggers: ['repeatable web workflow'],
        recommended_refs: ['knowledge/public/procedures/browser/navigate-web.md'],
      },
    });

    const saved = savePromotedMemoryRecord(candidate, { executionRole: 'mission_controller' });
    rememberWrite(pathResolver.resolve(saved.logicalPath));

    const hints = safeReadFile(scratchHintsPath, { encoding: 'utf8' }) as string;
    expect(hints).toContain(
      'Use the browser bridge when a workflow depends on deterministic site navigation.'
    );
    expect(hints).toContain('source_ref:');
    expect(hints).toContain('active/shared/tmp/hints-source.md');
  });

  it('rotates older hint sections into archive when the live file exceeds the cap', () => {
    const makeSection = (index: number) =>
      [
        `## LIVE-${String(index + 1).padStart(2, '0')} (2026-07-03)`,
        '',
        `Live hint ${index + 1}`,
        '',
        `source_ref: source-${index + 1}`,
        `evidence_refs:`,
        `- evidence-${index + 1}`,
        '',
      ].join('\n');

    const fixture = [
      '# Operational Hints',
      '',
      '> **Generated by** `pipelines/fragments/memory-distillation.json` (via `volatile-gc` → `memory-promotion-queue`).',
      '> Do not edit manually — content is overwritten by the distillation pipeline.',
      '> **Purpose**: Condensed operational learnings from recent missions and volatile working-memory faces,',
      '> surfaced here so Recovery and Alignment phases can read relevant hints without full knowledge search.',
      '',
      '<!-- Distillation pipeline will append structured hint blocks below this line -->',
      '',
      Array.from({ length: 50 }, (_, index) => makeSection(index)).join('\n'),
      '',
    ].join('\n');

    withExecutionContext('ecosystem_architect', () => {
      safeWriteFile(scratchHintsPath, fixture);
    });

    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'personal',
      track_id: 'TRK-DEMO-HINTS-ARCHIVE',
      track_name: 'Hints archive demo',
      title: 'Browser hint for archived rotation',
      summary: 'Use the browser bridge when a workflow depends on deterministic site navigation.',
      status: 'promoted',
      target_kind: 'knowledge_hint',
      evidence_refs: ['active/shared/tmp/hints-source.md'],
      metadata: {
        hint_scope: 'browser navigation',
        hint_triggers: ['repeatable web workflow'],
        recommended_refs: ['knowledge/public/procedures/browser/navigate-web.md'],
      },
    });

    const saved = savePromotedMemoryRecord(candidate, { executionRole: 'mission_controller' });
    rememberWrite(pathResolver.resolve(saved.logicalPath));

    const archivePath = pathResolver.resolve(
      `${scratchHintsDir}/archive/${saved.record.created_at.replace(/[:.]/gu, '-')}-${saved.record.record_id}.md`
    );
    rememberArchive(archivePath);

    const hints = safeReadFile(scratchHintsPath, { encoding: 'utf8' }) as string;
    const liveSections = hints.match(/^## /gm) || [];
    expect(liveSections).toHaveLength(50);
    expect(hints).toContain('## LIVE-02 (2026-07-03)');
    expect(hints).not.toContain('## LIVE-01 (2026-07-03)');

    const archived = safeReadFile(archivePath, { encoding: 'utf8' }) as string;
    expect(archived).toContain('# Archived Operational Hints');
    expect(archived).toContain('archived_sections: 1');
    expect(archived).toContain('## LIVE-01 (2026-07-03)');
  });

  describe('value threshold (isMeaningfulPromotionCandidate)', () => {
    function withFixture(
      overrides: Partial<Parameters<typeof createDistillCandidateRecord>[0]> = {}
    ) {
      return createDistillCandidateRecord({
        source_type: 'task_session',
        tier: 'public',
        title: 'Customer-facing presentation pattern',
        summary: 'Recurring deck-style update for the weekly stakeholder review.',
        status: 'proposed',
        target_kind: 'pattern',
        metadata: { applicability: ['delivery'] },
        ...overrides,
      });
    }

    it('rejects test tracks', () => {
      const c = withFixture({ track_id: 'TRK-TEST-REL1' });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
      expect(() => savePromotedMemoryRecord(c)).toThrow(NotMeaningfulPromotionCandidateError);
    });

    it('rejects generic fallback titles', () => {
      const c = withFixture({ title: 'Reusable pattern' });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
    });

    it('rejects too-short titles', () => {
      const c = withFixture({ title: 'Hi' });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
    });

    it('rejects too-short summaries', () => {
      const c = withFixture({ summary: 'short.' });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
    });

    it('rejects pattern with no applicability/steps/outcome metadata', () => {
      const c = withFixture({ metadata: {} });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
    });

    it('accepts a meaningful pattern candidate', () => {
      const c = withFixture();
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(true);
    });

    it('rejects sop_candidate with no procedure_steps', () => {
      const c = withFixture({
        target_kind: 'sop_candidate',
        title: 'Customer onboarding SOP',
        summary: 'Step-by-step procedure for onboarding a new SaaS customer.',
        metadata: {},
      });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
    });

    it('rejects knowledge_hint with no scope or triggers', () => {
      const c = withFixture({
        target_kind: 'knowledge_hint',
        title: 'Browser hint',
        summary: 'When the user opens a recurring site, suggest the cached selector.',
        metadata: {},
      });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
    });

    it('rejects report_template with no template_sections', () => {
      const c = withFixture({
        target_kind: 'report_template',
        title: 'Weekly progress report',
        summary: 'Standard weekly progress report shape used for stakeholder updates.',
        metadata: {},
      });
      expect(isMeaningfulPromotionCandidate(c).ok).toBe(false);
    });
  });
});

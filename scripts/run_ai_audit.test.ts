import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeRmSync, safeWriteFile, loadJson } from '@agent/core';
import {
  AI_AUDIT_CASES_SCHEMA,
  SKIP_REASON_STUB_BACKEND,
  buildAuditPrompt,
  enumerateInvariants,
  extractSection,
  parseInvariantMarkdown,
  renderReport,
  resolveScopeFiles,
  runAiAudit,
  type AiAuditReport,
  type AuditFn,
} from './run_ai_audit.js';

const tempDirs: string[] = [];

function tempDir(label: string): string {
  const dir = pathResolver.sharedTmp(
    `ai-audit-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      safeRmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup: janitor sweeps active/shared/tmp anyway
    }
  }
});

describe('invariant markdown parsing', () => {
  it('extracts name, scope, and section bodies', () => {
    const md = [
      '# Invariant: errors carry guidance',
      '',
      '## Scope',
      '',
      '- `libs/core/secure-io.ts`',
      '- `tests_ai/fixtures/*.ts`',
      '',
      '## Requirements',
      '',
      '- every error names the offending path',
    ].join('\n');
    const invariant = parseInvariantMarkdown('tests_ai/sample.md', md);
    expect(invariant.name).toBe('errors carry guidance');
    expect(invariant.scope).toEqual(['libs/core/secure-io.ts', 'tests_ai/fixtures/*.ts']);
    expect(extractSection(md, 'Requirements')).toContain('offending path');
  });

  it('enumerates the real tests_ai catalog, excluding the README', () => {
    const invariants = enumerateInvariants();
    expect(invariants.length).toBeGreaterThanOrEqual(3);
    expect(invariants.every((inv) => !/readme/i.test(inv.file))).toBe(true);
    const fixtureInvariant = invariants.find(
      (inv) => inv.file === 'tests_ai/fixture-error-message-guidance.md'
    );
    expect(fixtureInvariant).toBeDefined();
    const { files, missing } = resolveScopeFiles(fixtureInvariant!.scope);
    expect(missing).toEqual([]);
    expect(files.map((file) => file.path)).toContain('tests_ai/fixtures/report-store.ts');
  });

  it('builds an audit prompt embedding the invariant and the scoped files', () => {
    const invariant = parseInvariantMarkdown('tests_ai/x.md', '# Invariant: x\n## Scope\n- `a.ts`');
    const prompt = buildAuditPrompt(invariant, [
      { path: 'a.ts', content: 'const a = 1;', truncated: false },
    ]);
    expect(prompt).toContain('<<<INVARIANT');
    expect(prompt).toContain('### a.ts');
    expect(prompt).toContain('const a = 1;');
  });

  it('rejects scope paths outside the repository root', () => {
    expect(() => resolveScopeFiles(['/tmp/kyberion-secret.txt'])).toThrow(
      '[POLICY_VIOLATION] AI audit path'
    );
    expect(() => resolveScopeFiles(['../outside-secret.txt'])).toThrow(
      '[POLICY_VIOLATION] AI audit path'
    );
  });
});

describe('runAiAudit fail path (KC-05 acceptance #1, injected decision fn)', () => {
  it('reports the planted fixture violation as a failing case and exits non-zero', async () => {
    const outputDir = tempDir('fail');
    // Deterministic stand-in for the LLM auditor: flags the planted bare
    // `throw new Error('failed')` exactly like the invariant requires.
    const fakeAudit: AuditFn = async (_invariant, files) => ({
      cases: files.map((file) => {
        const violated = file.content.includes("throw new Error('failed')");
        return {
          name: `${file.path} :: error messages include recovery guidance`,
          pass: !violated,
          ...(violated ? { reason: 'planted violation: bare error without guidance' } : {}),
        };
      }),
    });

    const { report, reportPath, exitCode } = await runAiAudit({
      outputDir,
      auditFn: fakeAudit,
      includeSelfTestFixtures: true,
    });

    expect(exitCode).toBe(1);
    expect(report.status).toBe('failed');
    const fixtureResult = report.results.find(
      (result) => result.file === 'tests_ai/fixture-error-message-guidance.md'
    );
    expect(fixtureResult).toBeDefined();
    const failing = fixtureResult!.cases.filter((item) => !item.pass);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing[0]!.name).toContain('tests_ai/fixtures/report-store.ts');

    // KC-05 acceptance #2: report.json persisted with trace linkage.
    expect(safeExistsSync(reportPath)).toBe(true);
    const persisted = loadJson<AiAuditReport>(reportPath);
    expect(persisted.trace.trace_id).toBe(report.trace.trace_id);
    expect(persisted.trace.trace_path).toBeTruthy();
    expect(safeExistsSync(persisted.trace.trace_path!)).toBe(true);
    expect(persisted.trace.trace_path).toContain(path.join(outputDir, 'traces'));

    const rendered = renderReport(report, reportPath);
    expect(rendered).toContain('FAIL tests_ai/fixture-error-message-guidance.md');
  });
});

describe('runAiAudit stub-backend skip', () => {
  it('skips with an explicit report instead of fake-passing', async () => {
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
    const outputDir = tempDir('skip');

    const { report, reportPath, exitCode } = await runAiAudit({ outputDir });

    expect(exitCode).toBe(2);
    expect(report.status).toBe('skipped');
    expect(report.skip_reason).toContain(SKIP_REASON_STUB_BACKEND);
    expect(report.backend_mode).toBe('stub');
    expect(report.results).toEqual([]);
    expect(report.summary.total_cases).toBe(0);
    expect(safeExistsSync(reportPath)).toBe(true);
    expect(renderReport(report, reportPath)).toContain('SKIP ai-audit');
  });
});

describe('runAiAudit deterministic guards', () => {
  it('fails a missing scope entry without invoking the auditor', async () => {
    const invariantsDir = tempDir('inv');
    const outputDir = tempDir('out');
    safeWriteFile(
      path.join(invariantsDir, 'missing-scope.md'),
      ['# Invariant: ghost', '', '## Scope', '', '- `no/such/file.ts`', ''].join('\n')
    );
    const neverCalled: AuditFn = vi.fn(async () => ({ cases: [] }));

    const { report, exitCode } = await runAiAudit({
      invariantsDir,
      outputDir,
      auditFn: neverCalled,
    });

    expect(exitCode).toBe(1);
    expect(report.status).toBe('failed');
    expect(neverCalled).not.toHaveBeenCalled();
    expect(report.results[0]!.cases[0]!.reason).toContain('scope entry not found');
  });

  it('turns an auditor error into a failing case, never a silent pass', async () => {
    const invariantsDir = tempDir('inv-err');
    const outputDir = tempDir('out-err');
    safeWriteFile(
      path.join(invariantsDir, 'boom.md'),
      ['# Invariant: boom', '', '## Scope', '', '- `package.json`', ''].join('\n')
    );
    const throwing: AuditFn = async () => {
      throw new Error('backend unavailable');
    };

    const { report, exitCode } = await runAiAudit({
      invariantsDir,
      outputDir,
      auditFn: throwing,
    });

    expect(exitCode).toBe(1);
    expect(report.results[0]!.cases[0]!.pass).toBe(false);
    expect(report.results[0]!.cases[0]!.reason).toContain('backend unavailable');
  });

  it('rejects malformed auditor output via the shared schema', () => {
    expect(() => AI_AUDIT_CASES_SCHEMA.parse({ cases: [] })).toThrow();
    expect(() => AI_AUDIT_CASES_SCHEMA.parse({ cases: [{ name: 'x', pass: 'yes' }] })).toThrow();
  });
});

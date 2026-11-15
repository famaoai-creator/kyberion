import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { runWriteCommand, WRITE_USAGE, resolveRenderTarget } from './cli-write.js';
import { runReadCommand } from './cli-read.js';

describe('pnpm kyberion write', () => {
  let workDir = '';
  let briefPath = '';

  const brief = {
    kind: 'document-brief',
    artifact_family: 'document',
    document_type: 'report',
    document_profile: 'summary-report',
    title: 'Capability Verb Coverage',
    summary: 'Which capabilities are reachable through a single verb.',
    payload: {
      sections: [
        { heading: 'Findings', body: ['Authoring had no verb until now.'] },
        { heading: 'Recommendations', body: ['Keep the unifier op as the seam.'] },
      ],
    },
  };

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`cli-write-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    briefPath = path.join(workDir, 'brief.json');
    safeWriteFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('renders a docx from a brief and infers the target from --out', async () => {
    const out = path.join(workDir, 'report.docx');
    const output: string[] = [];
    const result = await runWriteCommand([briefPath, '--out', out], (text) => output.push(text));
    expect(result?.render_target).toBe('docx');
    expect(safeExistsSync(out)).toBe(true);
    expect(result?.bytes).toBeGreaterThan(0);
    expect(output.join('\n')).toMatch(/\[write\] wrote .*report\.docx \(docx/);
  });

  it('round-trips through read: what write produces, read gives back', async () => {
    const out = path.join(workDir, 'roundtrip.docx');
    await runWriteCommand([briefPath, '--out', out, '--to', 'docx'], () => {});
    const readBack: string[] = [];
    await runReadCommand([out], (text) => readBack.push(text));
    expect(readBack.join('\n')).toContain('Findings');
  });

  it('prints JSON with the resolved target and profile', async () => {
    const out = path.join(workDir, 'report-json.docx');
    const output: string[] = [];
    await runWriteCommand([briefPath, '--out', out, '--json'], (text) => output.push(text));
    const parsed = JSON.parse(output.join('\n'));
    expect(parsed.render_target).toBe('docx');
    expect(parsed.profile_id).toBe('summary-report');
    expect(parsed.output_path).toBe(path.relative(pathResolver.rootDir(), out));
  });

  it('resolves the render target from --to, then the brief, then the extension', () => {
    expect(resolveRenderTarget('pptx', 'docx', 'deck')).toBe('pptx');
    expect(resolveRenderTarget(undefined, 'xlsx', 'tracker')).toBe('xlsx');
    expect(resolveRenderTarget(undefined, undefined, 'a/b/report.pdf')).toBe('pdf');
  });

  it('refuses a target the extension contradicts', () => {
    expect(() => resolveRenderTarget('pptx', undefined, 'report.docx')).toThrow(
      /--to pptx writes \.pptx but --out ends in "\.docx"/
    );
  });

  it('refuses an unknown target and a non-json brief', async () => {
    expect(() => resolveRenderTarget('psd', undefined, 'art.psd')).toThrow(
      /unsupported render target "psd"/
    );
    const prose = path.join(workDir, 'brief.md');
    safeWriteFile(prose, '# Brief\n');
    await expect(
      runWriteCommand([prose, '--out', path.join(workDir, 'x.docx')], () => {})
    ).rejects.toThrow(/must be a \.json file[\s\S]*document_outline_from_brief/);
  });

  it('refuses paths outside the repository and a missing --out', async () => {
    await expect(
      runWriteCommand(['/Users/someone/brief.json', '--out', 'a.docx'], () => {})
    ).rejects.toThrow(/brief \/Users\/someone\/brief\.json is outside the repository/);
    await expect(runWriteCommand([briefPath], () => {})).rejects.toThrow(/--out is required/);
  });

  it('prints usage without a brief', async () => {
    await expect(runWriteCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion write/);
    const output: string[] = [];
    await runWriteCommand(['--help'], (text) => output.push(text));
    expect(output[0]).toBe(WRITE_USAGE);
  });
});

import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rootDir } from '@agent/core/path-resolver';
import { readJson } from '@agent/core/foundation';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';

// Only the external renderers (mmdc / d2) are faked: they "render" by writing
// the requested output so the op's size check sees a real file.
const renderCalls = vi.hoisted(() => [] as Array<{ bin: string; args: string[] }>);
vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExec: vi.fn((bin: string, args: string[] = [], options?: unknown) => {
      if (bin !== 'mmdc' && bin !== 'd2') return actual.safeExec(bin, args, options as never);
      renderCalls.push({ bin, args });
      const outPath = bin === 'mmdc' ? args[args.indexOf('-o') + 1]! : args[1]!;
      actual.safeWriteFile(outPath, '<svg/>');
      return '';
    }),
  };
});

import { handleAction } from './index.js';

const ROOT = rootDir();
const OUT_DIR = 'active/shared/tmp/media-diagram-document-ops-test';

function runPipeline(steps: unknown[], context: Record<string, unknown> = {}) {
  return handleAction({ action: 'pipeline', context, steps } as never) as Promise<{
    status: string;
    results: Array<{ status: string; error?: string }>;
    context: Record<string, any>;
  }>;
}

describe('media-actuator diagram and document ops', () => {
  beforeEach(() => {
    renderCalls.length = 0;
  });
  afterAll(() => {
    safeRmSync(path.join(ROOT, OUT_DIR), { recursive: true, force: true });
  });

  it('mermaid_render hands the source and a theme config to mmdc', async () => {
    const result = await runPipeline([
      {
        type: 'apply',
        op: 'mermaid_render',
        params: { source: 'graph TD; A-->B', path: `${OUT_DIR}/flow.svg`, width: 800 },
      },
    ]);
    expect(result.status).toBe('succeeded');
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]!.args).toEqual(
      expect.arrayContaining(['-o', path.join(ROOT, OUT_DIR, 'flow.svg'), '-c', '-w', '800'])
    );
    expect(safeExistsSync(path.join(ROOT, OUT_DIR, 'flow.svg'))).toBe(true);
  });

  it('d2_render passes layout and sketch flags to d2', async () => {
    const result = await runPipeline([
      {
        type: 'apply',
        op: 'd2_render',
        params: { source: 'a -> b', path: `${OUT_DIR}/flow-d2.svg`, layout: 'elk', sketch: true },
      },
    ]);
    expect(result.status).toBe('succeeded');
    expect(renderCalls[0]!.bin).toBe('d2');
    expect(renderCalls[0]!.args).toEqual(
      expect.arrayContaining([
        path.join(ROOT, OUT_DIR, 'flow-d2.svg'),
        '--layout',
        'elk',
        '--sketch',
      ])
    );
  });

  it('drawio_from_graph builds a draw.io document that drawio_write persists', async () => {
    const result = await runPipeline([
      {
        type: 'transform',
        op: 'drawio_from_graph',
        params: {
          title: 'Two tier',
          graph: {
            nodes: [
              { id: 'web', type: 'service', name: 'Web' },
              { id: 'db', type: 'database', name: 'DB' },
            ],
            edges: [{ from: 'web', to: 'db' }],
          },
        },
      },
      { type: 'apply', op: 'drawio_write', params: { path: `${OUT_DIR}/arch.drawio` } },
    ]);
    expect(result.status).toBe('succeeded');
    expect(result.context.last_drawio_graph.nodes).toHaveLength(2);
    const written = String(
      safeReadFile(path.join(ROOT, OUT_DIR, 'arch.drawio'), { encoding: 'utf8' })
    );
    expect(written).toContain('<mxfile');
    expect(written).toContain('Web');

    const empty = await runPipeline([
      { type: 'apply', op: 'drawio_write', params: { path: `${OUT_DIR}/empty.drawio` } },
    ]);
    expect(empty.status).toBe('failed');
    expect(empty.results[0]!.error).toContain('drawio_write requires XML content');
  });

  it('document_pdf_from_brief compiles a qualified invoice brief into a PDF protocol', async () => {
    const brief = readJson<Record<string, unknown>>(
      path.join(
        ROOT,
        'libs/actuators/media-actuator/examples/assets/document-brief-invoice-example.json'
      )
    );
    const result = await runPipeline(
      [{ type: 'transform', op: 'document_pdf_from_brief', params: { from: 'invoice_brief' } }],
      { invoice_brief: brief }
    );
    expect(result.status).toBe('succeeded');
    const protocol = result.context.last_pdf_design;
    expect(protocol.source.format).toBe('markdown');
    expect(protocol.source.body).toContain('合計請求額');
    expect(protocol.metadata.composition.document_profile).toBe('qualified-invoice');
  });

  it('proposal_content_from_storyline maps storyline slides to slide content data', async () => {
    const result = await runPipeline(
      [{ type: 'transform', op: 'proposal_content_from_storyline', params: {} }],
      {
        proposal_storyline: {
          design_system_id: 'kyberion-standard',
          slides: [
            { title: 'Why now', objective: 'Frame the problem', layout_key: 'title-body' },
            { title: 'Plan', body: ['Phase 1', 'Phase 2'], semantic_type: 'roadmap' },
          ],
        },
      }
    );
    expect(result.status).toBe('succeeded');
    expect(result.context.proposal_content_data).toEqual([
      expect.objectContaining({ title: 'Why now', body: ['Frame the problem'] }),
      expect.objectContaining({ title: 'Plan', body: ['Phase 1', 'Phase 2'] }),
    ]);

    const missing = await runPipeline([
      { type: 'transform', op: 'proposal_content_from_storyline', params: {} },
    ]);
    expect(missing.status).toBe('failed');
  });
});

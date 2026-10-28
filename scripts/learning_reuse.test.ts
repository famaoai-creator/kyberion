import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const calls = vi.hoisted(() => ({ read: vi.fn(), knowledge: vi.fn(), pipeline: vi.fn() }));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeReadFileSnapshot: calls.read,
}));
vi.mock('@agent/core/scope-context', () => ({ currentScope: () => ({ tier: 'public' }) }));
vi.mock('@agent/core/knowledge/knowledge-verification', () => ({
  inspectKnowledgeReuse: calls.knowledge,
}));
vi.mock('@agent/core/pipeline/pipeline-reuse', () => ({ inspectPipelineReuse: calls.pipeline }));
import { runLearningReuse } from './learning_reuse.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  calls.read.mockReturnValue(Buffer.from('actual revision bytes'));
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('learning reuse inspection facade', () => {
  it('does not read an asset for help or client scope overrides', async () => {
    await runLearningReuse(['--help']);
    await runLearningReuse(['--input', 'pipelines/example.json', '--tenant', 'other']);
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.pipeline).not.toHaveBeenCalled();
  });
  it('uses selected execution scope and current bytes, not a caller digest', async () => {
    const source = JSON.stringify({
      action: 'pipeline',
      version: '1.0.0',
      steps: [{ id: 'log', role: 'sink', op: 'system:log', params: { message: 'hello' } }],
    });
    calls.read.mockReturnValue(Buffer.from(source));
    await runLearningReuse(['--input', 'pipelines/example.json', '--json']);
    expect(calls.pipeline).toHaveBeenCalledWith({
      documentPath: 'pipelines/example.json',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      scope: { tier: 'public' },
    });
    expect(calls.knowledge).not.toHaveBeenCalled();
  });
  it('routes a JSON procedure recording to its actual verification ledger', async () => {
    calls.read.mockReturnValue(
      Buffer.from(JSON.stringify({ schema_version: 'service-recording.v1', steps: [] }))
    );
    await runLearningReuse(['--input', 'active/shared/runtime/recordings/example.json', '--json']);
    expect(calls.knowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        documentPath: 'active/shared/runtime/recordings/example.json',
        scope: { tier: 'public' },
      })
    );
    expect(calls.pipeline).not.toHaveBeenCalled();
  });
});

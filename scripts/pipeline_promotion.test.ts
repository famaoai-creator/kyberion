import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { loadPipelineRunJournal } from '@agent/core/pipeline/pipeline-run-journal';
import { validatePipelineAdf } from '@agent/core/pipeline/pipeline-contract';
import { executePipelineFile } from './run_pipeline.js';
import { promotePipelineAdf, installRepositoryPipelineTemplate } from './pipeline_promote.js';

const cleanup: string[] = [];
function source() {
  const name = `proof-${randomUUID()}`;
  const file = pathResolver.rootResolve(
    `active/shared/tmp/public/shared/promotion-tests/${name}.json`
  );
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(
    file,
    JSON.stringify({
      action: 'pipeline',
      name,
      steps: [{ id: 'log', op: 'system:log', params: { message: 'promotion proof' } }],
    })
  );
  cleanup.push(file);
  return { file, name, args: ['--input', file, '--name', name, '--no-llm'] };
}
afterEach(() => {
  for (const file of cleanup.splice(0)) safeRmSync(file, { force: true });
});

describe('run-to-promotion integration', () => {
  it('requires real completion evidence even for a schema-valid source', async () => {
    const fixture = source();
    await expect(promotePipelineAdf([...fixture.args, '--dry-run'])).rejects.toThrow(
      '--run <run-id>'
    );
    await expect(installRepositoryPipelineTemplate(fixture.args)).rejects.toThrow(
      'repository-owned'
    );
  });
  it('writes only an inert scoped draft without catalog publication', async () => {
    const fixture = source();
    const result = await promotePipelineAdf([...fixture.args, '--draft']);
    cleanup.push(pathResolver.rootResolve(result.target));
    expect(result.status).toBe('draft');
    expect(result.target).toContain('tmp/public/shared/pipeline-promotion/');
    const draft = JSON.parse(readTextFile(pathResolver.rootResolve(result.target)));
    expect(draft).toMatchObject({ kind: 'pipeline_promotion_draft', status: 'draft' });
    expect(() => validatePipelineAdf(draft)).toThrow();
  });
  it('records a real library run, verifies it, and rejects subsequent source edits', async () => {
    const fixture = source();
    const result = await executePipelineFile(fixture.file, { trustResolved: true, quiet: true });
    expect(result.status).toBe('succeeded');
    expect(result.runId).toEqual(expect.any(String));
    const journal = loadPipelineRunJournal(result.runId!, undefined, { tier: 'public' });
    cleanup.push(journal.path);
    const promoted = await promotePipelineAdf([
      ...fixture.args,
      '--run',
      result.runId!,
      '--trace',
      result.trace.traceId,
      '--dry-run',
    ]);
    expect(promoted).toMatchObject({
      status: 'verified_source',
      dry_run: true,
      target: `pipelines/${fixture.name}.json`,
    });
    safeWriteFile(fixture.file, readTextFile(fixture.file) + '\n');
    await expect(
      promotePipelineAdf([...fixture.args, '--run', result.runId!, '--dry-run'])
    ).rejects.toThrow('differs from the executed ADF');
  });
  it('keeps stricter payload journals in their private partition and cannot promote them publicly', async () => {
    const fixture = source();
    const result = await executePipelineFile(fixture.file, {
      trustResolved: true,
      quiet: true,
      payloadScope: { tier: 'personal' },
    });
    expect(result.status).toBe('succeeded');
    const journal = loadPipelineRunJournal(result.runId!, undefined, { tier: 'personal' });
    cleanup.push(journal.path);
    expect(journal.path).toContain('pipeline-library-runs/personal/shared/');
    await expect(
      promotePipelineAdf([...fixture.args, '--run', result.runId!, '--dry-run'])
    ).rejects.toThrow();
  });
});

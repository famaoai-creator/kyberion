import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile, safeRmSync, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import {
  readAdfInputTextFile,
  readValidatedPipelineAdf,
  readValidatedWorkflowAdf,
} from './adf-input.js';

const tmpRoot = pathResolver.sharedTmp('adf-input-tests');

function fixturePath(name: string): string {
  return path.join(tmpRoot, name);
}

describe('readValidatedPipelineAdf', () => {
  afterEach(() => {
    if (safeExistsSync(tmpRoot)) safeRmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rejects guardrail-violating pipelines before execution', () => {
    safeMkdir(tmpRoot, { recursive: true });
    const filePath = fixturePath('guardrail.json');
    safeWriteFile(
      filePath,
      JSON.stringify(
        {
          steps: [
            {
              op: 'demo:step',
              params: {},
              hooks: {
                before: [
                  {
                    type: 'command',
                    cmd: 'rm -rf /',
                  },
                ],
              },
            },
          ],
        },
        null,
        2
      ),
      { encoding: 'utf8' }
    );

    expect(() => readValidatedPipelineAdf(filePath, { trustResolved: true })).toThrow(
      'Invalid pipeline ADF guardrails'
    );
  });

  it('passes a benign pipeline through', () => {
    safeMkdir(tmpRoot, { recursive: true });
    const filePath = fixturePath('ok.json');
    safeWriteFile(
      filePath,
      JSON.stringify(
        {
          steps: [
            {
              op: 'demo:step',
              params: {},
              hooks: {
                before: [
                  {
                    type: 'http',
                    url: 'https://github.com/health',
                  },
                ],
              },
            },
          ],
        },
        null,
        2
      ),
      { encoding: 'utf8' }
    );

    expect(readValidatedPipelineAdf(filePath, { trustResolved: true })).toEqual(
      expect.objectContaining({
        steps: expect.any(Array),
      })
    );
  });

  it('fails closed when a trust-sensitive input omits the trust decision', () => {
    expect(() => readValidatedPipelineAdf('roles/PROCEDURE.md')).toThrow(
      '[TRUST_REQUIRED] project-local pipeline/template'
    );
  });

  it('rejects workflow inputs outside the repository before reading or importing', async () => {
    const outsidePath = path.join(pathResolver.rootDir(), '..', 'external-workflow.json');
    await expect(readValidatedWorkflowAdf(outsidePath, { trustResolved: true })).rejects.toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects a directory as a workflow input before reading it', async () => {
    await expect(readValidatedWorkflowAdf('scripts', { trustResolved: true })).rejects.toThrow(
      '[ADF_INPUT] input must be an existing regular file'
    );
  });

  it('loads a workflow module input and validates it like JSON ADF', async () => {
    safeMkdir(tmpRoot, { recursive: true });
    const filePath = fixturePath('workflow-module.ts');
    safeWriteFile(
      filePath,
      [
        'export default {',
        '  name: "workflow-module-test",',
        '  steps: [',
        '    {',
        '      op: "demo:step",',
        '      params: {},',
        '      hooks: {',
        '        before: [',
        '          {',
        '            type: "http",',
        '            url: "https://github.com/health",',
        '          },',
        '        ],',
        '      },',
        '    },',
        '  ],',
        '};',
      ].join('\n'),
      { encoding: 'utf8' }
    );

    await expect(readValidatedWorkflowAdf(filePath, { trustResolved: true })).resolves.toEqual(
      expect.objectContaining({
        name: 'workflow-module-test',
        steps: expect.any(Array),
      })
    );
  });

  it('rejects project-local workflow modules before importing them when trust is unresolved', async () => {
    const examplePath = path.resolve(
      pathResolver.rootDir(),
      'scripts/demos/workflow-as-code-example.ts'
    );

    await expect(readValidatedWorkflowAdf(examplePath, { trustResolved: false })).rejects.toThrow(
      '[TRUST_REQUIRED] project-local pipeline/template'
    );
  });

  it('loads the checked-in workflow-as-code example module', async () => {
    const examplePath = path.resolve(
      pathResolver.rootDir(),
      'scripts/demos/workflow-as-code-example.ts'
    );

    await expect(readValidatedWorkflowAdf(examplePath, { trustResolved: true })).resolves.toEqual(
      expect.objectContaining({
        name: 'workflow-as-code-example',
        action: 'pipeline',
        steps: expect.arrayContaining([
          expect.objectContaining({ op: 'system:log' }),
          expect.objectContaining({ op: 'core:transform' }),
          expect.objectContaining({ op: 'core:parallel_foreach', effort: 'medium' }),
          expect.objectContaining({ op: 'core:accumulate', effort: 'medium' }),
        ]),
      })
    );
  });

  it.each([
    'pipelines/full-health-report.json',
    'pipelines/voice-onboarding.json',
    'pipelines/launch-first-run-onboarding.json',
    'pipelines/system-upgrade-check.json',
  ])('loads representative checked-in pipeline %s with the wrapper baseline', async (relative) => {
    await expect(
      readValidatedWorkflowAdf(pathResolver.rootResolve(relative), { trustResolved: true })
    ).resolves.toEqual(
      expect.objectContaining({
        steps: expect.any(Array),
      })
    );
  });

  it('expands static includes before guardrail validation and rejects include cycles', async () => {
    const cyclePath = path.resolve(
      pathResolver.rootDir(),
      'pipelines/fragments/_test-run-pipeline-include-cycle.json'
    );

    await expect(readValidatedWorkflowAdf(cyclePath, { trustResolved: true })).rejects.toThrow(
      'circular reference detected'
    );
  });

  it('keeps repaired include fragments behind the safe JSON boundary', async () => {
    const source = String(
      (await import('@agent/core/secure-io')).safeReadFile(
        pathResolver.rootResolve('scripts/refactor/adf-input.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('parseSafeJsonInput(JSON.stringify(repaired)');
    expect(source).not.toContain('return JSON.parse(raw)');
  });

  it('rejects a directory before reading an include fragment', () => {
    expect(() => readAdfInputTextFile(pathResolver.rootResolve('pipelines'))).toThrow(
      'must be a regular file'
    );
  });

  it('applies the pre-trust boundary to static pipeline fragments', async () => {
    safeMkdir(tmpRoot, { recursive: true });
    const cyclePath = fixturePath('include-from-untrusted-root.json');
    safeWriteFile(
      cyclePath,
      JSON.stringify({
        steps: [{ op: 'core:include', params: { fragment: 'fragments/unknown.json' } }],
      }),
      { encoding: 'utf8' }
    );

    await expect(readValidatedWorkflowAdf(cyclePath, { trustResolved: false })).rejects.toThrow(
      '[TRUST_REQUIRED] project-local pipeline/template'
    );
  });
});

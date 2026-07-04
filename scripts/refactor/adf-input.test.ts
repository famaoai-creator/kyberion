import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile, safeRmSync, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { readValidatedPipelineAdf, readValidatedWorkflowAdf } from './adf-input.js';

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

    expect(() => readValidatedPipelineAdf(filePath)).toThrow('Invalid pipeline ADF guardrails');
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

    expect(readValidatedPipelineAdf(filePath)).toEqual(
      expect.objectContaining({
        steps: expect.any(Array),
      })
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

    await expect(readValidatedWorkflowAdf(filePath)).resolves.toEqual(
      expect.objectContaining({
        name: 'workflow-module-test',
        steps: expect.any(Array),
      })
    );
  });

  it('loads the checked-in workflow-as-code example module', async () => {
    const examplePath = path.resolve(
      pathResolver.rootDir(),
      'scripts/demos/workflow-as-code-example.ts'
    );

    await expect(readValidatedWorkflowAdf(examplePath)).resolves.toEqual(
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
});

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile, safeRmSync, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { readValidatedPipelineAdf } from './adf-input.js';

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
});

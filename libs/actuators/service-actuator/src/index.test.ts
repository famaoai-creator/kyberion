import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  safeReadFile: vi.fn(),
  executeServicePreset: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<unknown>, _options?: unknown) => fn()),
}));
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeExec: mocks.safeExec,
    safeReadFile: mocks.safeReadFile,
    executeServicePreset: mocks.executeServicePreset,
    withRetry: mocks.withRetry,
  };
});

describe('service-actuator handleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_ALLOW_UNSAFE_CLI;
  });

  it('uses the manifest retry policy for service pipeline steps', async () => {
    mocks.executeServicePreset.mockResolvedValue({ ok: true });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-actuator/manifest.json')) {
        return JSON.stringify({
          recovery_policy: {
            retry: {
              maxRetries: 4,
              initialDelayMs: 250,
              maxDelayMs: 2000,
              factor: 3,
              jitter: false,
            },
          },
        });
      }
      return '';
    });

    const { handleAction } = await import('./index.js');

    await handleAction({
      action: 'pipeline',
      steps: [
        {
          op: 'preset',
          params: {
            service_id: 'backlog',
            action: 'get_issues',
            params: { space: 'acme' },
          },
        },
      ],
    } as any);

    expect(mocks.withRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxRetries: 4,
        initialDelayMs: 250,
        maxDelayMs: 2000,
        factor: 3,
        jitter: false,
      }),
    );
  });

  it('delegates PRESET mode to the shared service engine', async () => {
    mocks.executeServicePreset.mockResolvedValue({ ok: true });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      service_id: 'github',
      mode: 'PRESET',
      action: 'create_issue',
      params: { owner: 'famaoai', repo: 'kyberion' },
      auth: 'secret-guard',
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'github',
      'create_issue',
      { owner: 'famaoai', repo: 'kyberion' },
      'secret-guard',
    );
    expect(result).toEqual({ ok: true });
  });

  it('blocks raw CLI mode unless explicitly enabled', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        service_id: 'slack',
        mode: 'CLI',
        action: 'post-message',
        params: { text: 'hello' },
      }),
    ).rejects.toThrow('CLI execution disabled');
  });

  it('executes raw CLI mode when unsafe CLI is enabled', async () => {
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
    mocks.safeExec.mockReturnValue('cli-output');
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      service_id: 'voice',
      mode: 'CLI',
      action: 'speak',
      params: { text: 'hello' },
    });

    expect(mocks.safeExec).toHaveBeenCalledWith('voice', ['speak', 'hello']);
    expect(result).toEqual({ output: 'cli-output' });
  });

  it('emits service actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/service-action.schema.json'));

    const directRequest = {
      service_id: 'github',
      mode: 'API',
      action: 'create_issue',
      method: 'POST',
      params: {
        owner: 'famaoai',
        repo: 'kyberion',
        title: 'Schema check',
      },
      auth: 'secret-guard',
    };
    const pipelineRequest = {
      action: 'pipeline',
      context: {
        request_id: 'REQ-1',
      },
      steps: [
        {
          op: 'api',
          params: {
            service_id: 'github',
            action: 'create_issue',
            params: {
              owner: 'famaoai',
              repo: 'kyberion',
            },
            auth: 'secret-guard',
            method: 'POST',
          },
        },
      ],
    };

    expect(validate(directRequest), JSON.stringify(validate.errors || [])).toBe(true);
    expect(validate(pipelineRequest), JSON.stringify(validate.errors || [])).toBe(true);
  });
});

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import {
  compileSchemaFromPath,
  pathResolver,
  registerOpPreflightListener,
  resetOpPreflight,
} from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  safeReadFile: vi.fn(),
  executeServicePreset: vi.fn(),
  executeMcp: vi.fn(),
  controlPlane: {
    enforceIntroduction: vi.fn(),
    recordObservation: vi.fn(),
    projectTaint: vi.fn(() => ({
      missionId: 'mission-test',
      highestTier: 'public' as const,
      tenants: [],
      prohibitExternal: false,
      observationIds: [],
    })),
  },
  retry: vi.fn(async (fn: () => Promise<unknown>, _options?: unknown) => fn()),
}));
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

vi.mock('@agent/core', async () => {
  const actual = (await vi.importActual('@agent/core')) as any;
  return {
    ...actual,
    safeExec: mocks.safeExec,
    safeReadFile: mocks.safeReadFile,
    executeServicePreset: mocks.executeServicePreset,
    executeMcp: mocks.executeMcp,
    CloudflareOsControlPlane: class {
      enforceIntroduction(...args: any[]) {
        return mocks.controlPlane.enforceIntroduction(...args);
      }
      recordObservation(...args: any[]) {
        return mocks.controlPlane.recordObservation(...args);
      }
    },
    buildGovernedRetryOptions: vi.fn(({ manifestPath, defaults, override }: any) => {
      let retryPolicy = {};
      try {
        const manifest = JSON.parse(String(mocks.safeReadFile(manifestPath)));
        retryPolicy = manifest?.recovery_policy?.retry || {};
      } catch {
        retryPolicy = {};
      }
      return { ...defaults, ...retryPolicy, ...(override || {}), shouldRetry: vi.fn() };
    }),
    retry: mocks.retry,
  };
});

describe('service-actuator handleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.controlPlane.enforceIntroduction.mockReset();
    mocks.controlPlane.recordObservation.mockReset();
    mocks.controlPlane.projectTaint.mockReset();
    mocks.controlPlane.projectTaint.mockReturnValue({
      missionId: 'mission-test',
      highestTier: 'public',
      tenants: [],
      prohibitExternal: false,
      observationIds: [],
    });
    delete process.env.KYBERION_ALLOW_UNSAFE_CLI;
    delete process.env.MISSION_ID;
  });

  afterEach(() => resetOpPreflight());

  it('routes direct service execution through the shared preflight waterfall', async () => {
    const seen: string[] = [];
    registerOpPreflightListener({
      id: 'service-actuator-test-observer',
      run: (call) => {
        seen.push(`${call.source}:${call.op}`);
      },
    });
    mocks.executeServicePreset.mockResolvedValue({ ok: true });
    const { handleAction } = await import('./index.js');

    await handleAction({
      service_id: 'github',
      mode: 'PRESET',
      action: 'create_issue',
      params: { owner: 'famaoai', repo: 'kyberion' },
    });

    expect(seen).toEqual(['actuator:service:preset:create_issue']);
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

    expect(mocks.retry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxRetries: 4,
        initialDelayMs: 250,
        maxDelayMs: 2000,
        factor: 3,
        jitter: false,
      })
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
      'secret-guard'
    );
    expect(result).toEqual({ ok: true });
  });

  it('records a canonical PRESET call when a recording session is attached', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      number: 42,
      html_url: 'https://example.invalid/42',
    });
    const { startServiceRecordingSession } = await import('@agent/core');
    const session = startServiceRecordingSession({
      target_name: 'Issue intake',
      recording_id: 'svc-actuator-test',
    });
    const { handleAction } = await import('./index.js');

    await handleAction({
      service_id: 'github',
      mode: 'PRESET',
      action: 'create_issue',
      params: {
        owner: 'famaoai',
        repo: 'kyberion',
        title: '{{input.title}}',
      },
      auth: 'secret-guard',
      context: { service_recording_session_id: session.recording_id },
    });

    expect(session.toRecording().steps[0]).toMatchObject({
      service_id: 'github',
      action: 'create_issue',
      result_summary: { kind: 'object', keys: ['number', 'html_url'] },
    });
  });

  it('exposes side-effect-free Service Harness describe and plan actions', async () => {
    const { handleAction } = await import('./index.js');

    const descriptor = await handleAction({
      service_id: 'github',
      mode: 'HARNESS',
      action: 'describe',
      params: { detail: false },
    });
    expect(descriptor).toMatchObject({
      kind: 'service-harness-descriptor.v1',
      service_id: 'github',
    });

    const plan = await handleAction({
      service_id: 'github',
      mode: 'HARNESS',
      action: 'plan',
      params: {
        operation: 'create_issue',
        inputs: { owner: 'famaoai', repo: 'kyberion' },
      },
    });
    expect(plan).toMatchObject({
      kind: 'service-operation-plan.v1',
      service_id: 'github',
      action: 'create_issue',
      valid: false,
      approval_required: true,
    });

    const receipt = await handleAction({
      service_id: 'github',
      mode: 'HARNESS',
      action: 'receipt',
      params: {
        operation: 'create_issue',
        inputs: { owner: 'famaoai', repo: 'kyberion', access_token: 'hidden' },
        result: { id: 42 },
        error: 'token=hidden',
      },
    });
    expect(receipt).toMatchObject({
      kind: 'service-execution-receipt.v1',
      status: 'succeeded',
      inputs: { access_token: '[REDACTED]' },
      error: 'token=[REDACTED]',
    });
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('enforces an explicitly requested resource introduction before service execution', async () => {
    process.env.MISSION_ID = 'mission-introduction-test';
    mocks.controlPlane.enforceIntroduction.mockImplementation(() => {
      throw new Error('[POLICY_VIOLATION] Resource introduction required');
    });
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        service_id: 'github',
        mode: 'PRESET',
        action: 'create_issue',
        params: { title: 'blocked' },
        context: {
          mission_id: 'mission-introduction-test',
          resource_ref: 'repo:famaoai/kyberion',
          introduction_mode: 'enforce',
          resource_scope: 'write',
          security_scope: {
            tenant_id: 'tenant-a',
            mission_id: 'mission-introduction-test',
            read_tiers: ['public'],
            write_tier: 'public',
            purpose: 'create issue',
          },
        },
      })
    ).rejects.toThrow('Resource introduction required');
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('records an explicitly described service observation after a read', async () => {
    process.env.MISSION_ID = 'mission-observation-test';
    mocks.executeServicePreset.mockResolvedValue({ issues: [] });
    const { handleAction } = await import('./index.js');

    await handleAction({
      service_id: 'github',
      mode: 'PRESET',
      action: 'list_issues',
      params: {},
      context: {
        mission_id: 'mission-observation-test',
        resource_ref: 'repo:famaoai/kyberion',
        observation: {
          tier: 'public',
          purpose: 'review backlog',
          summary: 'issue list',
        },
        security_scope: {
          tenant_id: 'tenant-a',
          mission_id: 'mission-observation-test',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'review backlog',
        },
      },
    });

    expect(mocks.controlPlane.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-observation-test',
        resourceRef: 'repo:famaoai/kyberion',
        tier: 'public',
        purpose: 'review backlog',
      })
    );
  });

  it('derives observation sensitivity from the security scope, not caller claims', async () => {
    process.env.MISSION_ID = 'mission-observation-taint-test';
    mocks.executeServicePreset.mockResolvedValue({ issues: [] });
    const { handleAction } = await import('./index.js');

    await handleAction({
      service_id: 'github',
      mode: 'PRESET',
      action: 'list_issues',
      params: {},
      context: {
        resource_ref: 'repo:famaoai/kyberion',
        observation: {
          tier: 'public',
          purpose: 'caller-supplied purpose must be ignored',
          summary: 'issue list',
        },
        security_scope: {
          tenant_id: 'tenant-a',
          mission_id: 'mission-observation-taint-test',
          read_tiers: ['public', 'confidential'],
          write_tier: 'confidential',
          purpose: 'review confidential backlog',
        },
      },
    });

    expect(mocks.controlPlane.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'confidential',
        purpose: 'review confidential backlog',
      })
    );
  });

  it('does not turn observation persistence failure into a side-effect retry', async () => {
    process.env.MISSION_ID = 'mission-observation-retry-test';
    mocks.executeServicePreset.mockResolvedValue({ ok: true });
    mocks.controlPlane.recordObservation.mockImplementation(() => {
      throw new Error('observation store unavailable');
    });
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        service_id: 'github',
        mode: 'PRESET',
        action: 'list_issues',
        params: {},
        context: {
          resource_ref: 'repo:famaoai/kyberion',
          observation: { summary: 'issue list' },
          security_scope: {
            tenant_id: 'tenant-a',
            mission_id: 'mission-observation-retry-test',
            read_tiers: ['public'],
            write_tier: 'public',
            purpose: 'review backlog',
          },
        },
      })
    ).resolves.toEqual({ ok: true });
    expect(mocks.executeServicePreset).toHaveBeenCalledTimes(1);
  });

  it('blocks raw CLI mode unless explicitly enabled', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        service_id: 'slack',
        mode: 'CLI',
        action: 'post-message',
        params: { text: 'hello' },
      })
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

  it('delegates CLI mode to service presets when a matching preset exists', async () => {
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
    mocks.executeServicePreset.mockResolvedValue({ ok: true, delegated: true });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      service_id: 'voice',
      mode: 'CLI',
      action: 'speak_local',
      params: { text: 'hello' },
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'voice',
      'speak_local',
      { text: 'hello' },
      'none'
    );
    expect(mocks.safeExec).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, delegated: true });
  });

  it('executes MCP mode when unsafe CLI is enabled', async () => {
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
    mocks.executeMcp.mockResolvedValue({ tools: [] });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      service_id: 'github-mcp',
      mode: 'MCP',
      action: 'search_repositories',
      params: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    });

    expect(mocks.executeMcp).toHaveBeenCalledWith(
      'npx',
      ['-y', '@modelcontextprotocol/server-github'],
      expect.objectContaining({ action: 'call_tool', name: 'search_repositories' })
    );
    expect(result).toEqual({ tools: [] });
  });

  it('emits service actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'schemas/service-action.schema.json')
    );

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
      context: {
        mission_id: 'mission-schema-test',
        resource_ref: 'repo:famaoai/kyberion',
        introduction_mode: 'warn',
      },
    };
    const mcpRequest = {
      service_id: 'github-mcp',
      mode: 'MCP',
      action: 'search_repositories',
      params: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
    };
    const harnessRequest = {
      service_id: 'github',
      mode: 'HARNESS',
      action: 'plan',
      params: {
        operation: 'create_issue',
        inputs: { owner: 'famaoai', repo: 'kyberion' },
      },
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
            context: {
              mission_id: 'mission-schema-test',
              resource_ref: 'repo:famaoai/kyberion',
              introduction_mode: 'warn',
            },
          },
        },
      ],
    };

    expect(validate(directRequest), JSON.stringify(validate.errors || [])).toBe(true);
    expect(validate(mcpRequest), JSON.stringify(validate.errors || [])).toBe(true);
    expect(validate(harnessRequest), JSON.stringify(validate.errors || [])).toBe(true);
    expect(validate(pipelineRequest), JSON.stringify(validate.errors || [])).toBe(true);
  });
});

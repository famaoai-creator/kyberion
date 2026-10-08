import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../foundation/json.js';
import * as pathResolver from '../path-resolver.js';

// checkProviderEgress raises an ops-alert on every denial; keep the shared
// ops-alerts sink untouched by these tests.
vi.mock('../ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));
import {
  inspectLlmResolution,
  invokeShellProfile,
  type LlmPolicyConfig,
  parseLlmResponse,
  probeLlmCommandAvailability,
  registerStructuredRunner,
  resolveLlmConfig,
  runStructuredLlmProfile,
  runAdaptiveStructuredLlmProfile,
} from './mission-llm.js';

describe('mission-llm resolution', () => {
  const originalProfile = process.env.KYBERION_WISDOM_LLM_PROFILE;

  beforeEach(() => {
    delete process.env.KYBERION_WISDOM_LLM_PROFILE;
  });

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env.KYBERION_WISDOM_LLM_PROFILE;
    } else {
      process.env.KYBERION_WISDOM_LLM_PROFILE = originalProfile;
    }
  });

  it('requires a JSON object envelope before parsing the LLM result', () => {
    expect(parseLlmResponse(JSON.stringify({ result: JSON.stringify({ answer: 1 }) }))).toEqual({
      answer: 1,
    });
    expect(() => parseLlmResponse('null')).toThrow('envelope must be a JSON object');
    expect(() => parseLlmResponse('[]')).toThrow('envelope must be a JSON object');
  });

  const policy = {
    default_profile: 'heavy',
    purpose_map: {
      distill: 'heavy',
    },
    profiles: {
      heavy: {
        command: 'codex',
        args: [],
        timeout_ms: 10,
        response_format: 'json_envelope',
        adapter: 'codex-cli',
      },
      standard: {
        command: 'gemini',
        args: ['-p', '{prompt}'],
        timeout_ms: 10,
        response_format: 'raw_json',
      },
      light: {
        command: 'codex',
        args: [],
        timeout_ms: 10,
        response_format: 'json_envelope',
        adapter: 'codex-cli',
      },
    },
  };

  it('selects the first available profile after probing real command health', () => {
    const status = inspectLlmResolution('distill', policy as any, {
      userTools: {},
      isCommandAvailable: (command) => ({
        available: command !== 'codex',
        reason: command === 'codex' ? 'broken binary' : undefined,
      }),
    });

    expect(status.selectedProfile).toBe('standard');
    expect(status.selectedCommand).toBe('gemini');
    expect(status.checkedProfiles[0]?.available).toBe(false);
    expect(status.checkedProfiles[0]?.reason).toContain('broken binary');

    const profile = resolveLlmConfig('distill', policy as any, {
      userTools: {},
      isCommandAvailable: (command) => ({
        available: command !== 'codex',
        reason: command === 'codex' ? 'broken binary' : undefined,
      }),
    });

    expect(profile.command).toBe('gemini');
  });

  it('throws a clear error when no real backend is usable', () => {
    expect(() =>
      resolveLlmConfig('distill', policy as any, {
        userTools: {},
        isCommandAvailable: () => ({ available: false, reason: 'unavailable' }),
      })
    ).toThrow(/No usable LLM tool available/);
  });

  it('prefers codex when it is the first healthy backend', () => {
    const status = inspectLlmResolution('distill', policy as any, {
      userTools: {},
      isCommandAvailable: (command) => ({
        available: command === 'codex',
        reason: command !== 'codex' ? 'unavailable' : undefined,
      }),
    });

    expect(status.selectedProfile).toBe('heavy');
    expect(status.selectedCommand).toBe('codex');
  });

  it('applies organization overrides before user overrides', () => {
    const organizationProfile = {
      version: '1.0.0',
      organization_id: 'demo-org',
      name: 'Demo Org',
      mission_defaults: {
        default_mission_class: 'operations_and_release',
      },
      team_defaults: {
        default_team_template: 'default',
      },
      llm: {
        profile_overrides: {
          heavy: {
            command: 'org-codex',
            args: ['--org'],
            adapter: 'codex-cli',
          },
        },
      },
    } as any;

    const orgProfile = resolveLlmConfig('distill', policy as any, {
      userTools: {},
      organizationProfile,
      isCommandAvailable: (command) => ({
        available: command === 'org-codex',
      }),
    });
    expect(orgProfile.command).toBe('org-codex');
    expect(orgProfile.args).toEqual(['--org']);

    const userOverrideProfile = resolveLlmConfig('distill', policy as any, {
      userTools: {
        profile_overrides: {
          heavy: {
            command: 'user-codex',
            args: ['--user'],
          },
        },
      },
      organizationProfile,
      isCommandAvailable: (command) => ({
        available: command === 'user-codex' || command === 'org-codex',
      }),
    });
    expect(userOverrideProfile.command).toBe('user-codex');
    expect(userOverrideProfile.args).toEqual(['--user']);
  });

  it('falls back to builtin codex when no configured profile is usable', () => {
    const status = inspectLlmResolution('summarize', { profiles: {} } as any, {
      userTools: {},
      isCommandAvailable: (command) => ({
        available: command === 'codex',
        reason: command !== 'codex' ? 'unavailable' : undefined,
      }),
    });

    expect(status.selectedProfile).toBe('builtin-fallback');
    expect(status.selectedCommand).toBe('codex');

    const profile = resolveLlmConfig('summarize', { profiles: {} } as any, {
      userTools: {},
      isCommandAvailable: (command) => ({
        available: command === 'codex',
        reason: command !== 'codex' ? 'unavailable' : undefined,
      }),
    });

    expect(profile.command).toBe('codex');
    expect(profile.adapter).toBe('codex-cli');
  });

  it('dispatches to a custom adapter without hardcoded provider branches', async () => {
    registerStructuredRunner('test-local-llm', async ({ prompt, schema }) => {
      const parsed = schema.parse({ answer: prompt.length });
      return parsed;
    });

    const result = await runStructuredLlmProfile(
      {
        command: 'local-llm',
        args: ['--structured'],
        adapter: 'test-local-llm',
      },
      'hello world',
      z.object({ answer: z.number() })
    );

    expect(result).toEqual({ answer: 11 });
  });

  it('uses a reversible named seam for structured runners', () => {
    const name = `test-seam-runner-${process.pid}`;
    const runner = async () => ({ answer: 1 });
    const dispose = registerStructuredRunner(name, runner, {
      provenance: 'generated',
      source: 'mission-llm.test.ts',
    });

    expect(() => registerStructuredRunner(name, runner)).toThrow(/already registered/);
    dispose();
  });

  it('automatically falls back to the next profile on QUOTA_EXHAUSTED', async () => {
    const calls: string[] = [];
    registerStructuredRunner('quota-first', async () => {
      calls.push('heavy');
      const error = new Error('QUOTA_EXHAUSTED');
      (error as any).cause = { code: 429 };
      throw error;
    });
    registerStructuredRunner('quota-second', async ({ prompt }) => {
      calls.push('standard');
      return { answer: prompt.length };
    });

    const result = await runAdaptiveStructuredLlmProfile(
      'test-purpose',
      'hello world',
      z.object({ answer: z.number() }),
      {
        isCommandAvailable: (command) => ({
          available: command === 'heavy-cmd' || command === 'standard-cmd',
        }),
        policy: {
          default_profile: 'heavy',
          profiles: {
            heavy: { command: 'heavy-cmd', args: [], adapter: 'quota-first' },
            standard: { command: 'standard-cmd', args: [], adapter: 'quota-second' },
          },
        },
      }
    );

    expect(result).toEqual({ answer: 11 });
    expect(calls).toEqual(['heavy', 'standard']);
  });
});

describe('probeLlmCommandAvailability', () => {
  const originalBin = process.env.KYBERION_CODEX_CLI_BIN;

  afterEach(() => {
    if (originalBin === undefined) delete process.env.KYBERION_CODEX_CLI_BIN;
    else process.env.KYBERION_CODEX_CLI_BIN = originalBin;
  });

  // The codex-cli adapter runs resolveCodexBinary(), not `codex` from PATH; a
  // project-local shim answering `codex --version` must not make the profile
  // look available, or the adaptive loop never reaches the next profile.
  it('probes the codex binary the adapter would run', () => {
    process.env.KYBERION_CODEX_CLI_BIN = process.execPath;
    expect(probeLlmCommandAvailability('codex')).toEqual({ available: true });
    process.env.KYBERION_CODEX_CLI_BIN = `${process.execPath}-missing-codex`;
    expect(probeLlmCommandAvailability('codex').available).toBe(false);
  });
});

describe('shipped wisdom-policy claude profile', () => {
  const originalProfile = process.env.KYBERION_WISDOM_LLM_PROFILE;
  const shippedPolicy = readJson<{ llm: LlmPolicyConfig }>(
    pathResolver.knowledge('product/governance/wisdom-policy.json')
  ).llm;

  beforeEach(() => {
    delete process.env.KYBERION_WISDOM_LLM_PROFILE;
  });

  afterEach(() => {
    if (originalProfile === undefined) delete process.env.KYBERION_WISDOM_LLM_PROFILE;
    else process.env.KYBERION_WISDOM_LLM_PROFILE = originalProfile;
  });

  it('selects the claude profile when codex and gemini are unavailable', () => {
    const isCommandAvailable = (command: string) => ({
      available: command === 'claude',
      reason: command === 'claude' ? undefined : 'not installed',
    });
    const status = inspectLlmResolution('distill', shippedPolicy, {
      userTools: {},
      organizationProfile: null,
      isCommandAvailable,
    });

    expect(status.selectedProfile).toBe('claude');
    expect(status.selectedCommand).toBe('claude');
    expect(status.checkedProfiles.map((entry) => entry.name)).toEqual([
      'heavy',
      'standard',
      'light',
      'claude',
    ]);

    const profile = resolveLlmConfig('distill', shippedPolicy, {
      userTools: {},
      organizationProfile: null,
      isCommandAvailable,
    });
    expect(profile).toMatchObject({
      command: 'claude',
      adapter: 'claude-cli',
      args: ['-p', '--output-format', 'json'],
      prompt_via: 'stdin',
      response_format: 'json_envelope',
    });
  });

  it('keeps codex first when every backend is available', () => {
    const status = inspectLlmResolution('distill', shippedPolicy, {
      userTools: {},
      organizationProfile: null,
      isCommandAvailable: () => ({ available: true }),
    });

    expect(status.selectedProfile).toBe('heavy');
    expect(status.selectedCommand).toBe('codex');
    expect(status.checkedProfiles.map((entry) => entry.name)).toEqual(['heavy']);
  });

  it('parses the claude print-mode JSON result envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '```json\n{"answer": 7}\n```',
    });
    expect(parseLlmResponse(stdout, shippedPolicy.profiles.claude.response_format)).toEqual({
      answer: 7,
    });
  });
});

describe('claude binary resolution', () => {
  const originalBin = process.env.KYBERION_CLAUDE_CLI_BIN;

  afterEach(() => {
    if (originalBin === undefined) delete process.env.KYBERION_CLAUDE_CLI_BIN;
    else process.env.KYBERION_CLAUDE_CLI_BIN = originalBin;
  });

  it('probes and runs the pinned KYBERION_CLAUDE_CLI_BIN instead of PATH claude', () => {
    process.env.KYBERION_CLAUDE_CLI_BIN = process.execPath;
    expect(probeLlmCommandAvailability('claude')).toEqual({ available: true });
    const stdout = invokeShellProfile('{"ok":true}', {
      command: 'claude',
      args: ['-e', 'process.stdout.write(process.argv[1])', '{prompt}'],
      timeout_ms: 10_000,
    });
    expect(stdout).toBe('{"ok":true}');

    // A pinned binary is never second-guessed by the PATH fallback.
    process.env.KYBERION_CLAUDE_CLI_BIN = `${process.execPath}-missing-claude`;
    expect(probeLlmCommandAvailability('claude').available).toBe(false);
  });
});

describe('LLM prompt transport', () => {
  const originalBin = process.env.KYBERION_CLAUDE_CLI_BIN;
  // Echoes what the child received: its stdin and its argv.
  const echoScript =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({stdin:d,argv:process.argv.slice(1)})))";

  afterEach(() => {
    if (originalBin === undefined) delete process.env.KYBERION_CLAUDE_CLI_BIN;
    else process.env.KYBERION_CLAUDE_CLI_BIN = originalBin;
  });

  it('ships the claude profile with the prompt on stdin, never in argv', () => {
    const claude = readJson<{ llm: LlmPolicyConfig }>(
      pathResolver.knowledge('product/governance/wisdom-policy.json')
    ).llm.profiles.claude;
    expect(claude.prompt_via).toBe('stdin');
    expect(claude.args).not.toContain('{prompt}');
  });

  it('hands a prompt_via=stdin claude profile the prompt on stdin and not in argv', () => {
    process.env.KYBERION_CLAUDE_CLI_BIN = process.execPath;
    const prompt = 'CONFIDENTIAL mission evidence 8f3a';
    const raw = invokeShellProfile(prompt, {
      command: 'claude',
      args: ['-e', echoScript],
      prompt_via: 'stdin',
      timeout_ms: 10_000,
    });
    const received = JSON.parse(raw) as { stdin: string; argv: string[] };
    expect(received.stdin).toBe(prompt);
    expect(received.argv.join(' ')).not.toContain('8f3a');
  });

  it('refuses a stdin profile that still carries a {prompt} argv placeholder', () => {
    expect(() =>
      invokeShellProfile('secret', {
        command: process.execPath,
        args: ['-e', '0', '{prompt}'],
        prompt_via: 'stdin',
      })
    ).toThrow(/prompt_via "stdin"/);
  });
});

describe('runAdaptiveStructuredLlmProfile provider egress gate', () => {
  const calls: string[] = [];
  const disposers: Array<() => void> = [];
  const schema = z.object({ answer: z.number() });
  // `claude` is declared training_use 'unknown' in the shipped
  // provider-egress-policy.json and no tenant attests it here.
  const policy = {
    default_profile: 'heavy',
    purpose_map: { distill: 'heavy' },
    profiles: {
      heavy: { command: 'claude', args: [], adapter: 'egress-gate-claude' },
    },
  };

  beforeEach(() => {
    calls.length = 0;
    disposers.push(
      registerStructuredRunner('egress-gate-claude', async () => {
        calls.push('claude');
        return { answer: 1 };
      })
    );
  });

  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  it('never invokes a non-attested provider for confidential material', async () => {
    await expect(
      runAdaptiveStructuredLlmProfile('distill', 'confidential prompt', schema, {
        policy,
        isCommandAvailable: () => ({ available: true }),
        egress: { dataTier: 'confidential' },
      })
    ).rejects.toThrow(/All LLM models exhausted/);
    expect(calls).toEqual([]);
  });

  it('denies a profile whose provider cannot be identified', async () => {
    disposers.push(
      registerStructuredRunner('egress-gate-unknown', async () => {
        calls.push('unknown');
        return { answer: 2 };
      })
    );
    await expect(
      runAdaptiveStructuredLlmProfile('distill', 'personal prompt', schema, {
        policy: {
          profiles: { heavy: { command: 'mystery-llm', args: [], adapter: 'egress-gate-unknown' } },
        },
        isCommandAvailable: () => ({ available: true }),
        egress: { dataTier: 'personal' },
      })
    ).rejects.toThrow(/All LLM models exhausted/);
    expect(calls).toEqual([]);
  });

  it('still invokes the provider for public material', async () => {
    const result = await runAdaptiveStructuredLlmProfile('distill', 'public prompt', schema, {
      policy,
      isCommandAvailable: () => ({ available: true }),
      egress: { dataTier: 'public' },
    });
    expect(result).toEqual({ answer: 1 });
    expect(calls).toEqual(['claude']);
  });
});

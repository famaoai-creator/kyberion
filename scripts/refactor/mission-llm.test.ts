import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectLlmResolution,
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

  const policy = {
    default_profile: 'heavy',
    purpose_map: {
      distill: 'heavy',
    },
    profiles: {
      heavy: {
        command: 'claude',
        args: ['-p', '{prompt}', '--output-format', 'json'],
        timeout_ms: 10,
        response_format: 'json_envelope',
      },
      standard: {
        command: 'gemini',
        args: ['-p', '{prompt}'],
        timeout_ms: 10,
        response_format: 'raw_json',
      },
      light: {
        command: 'codex',
        args: ['-p', '{prompt}'],
        timeout_ms: 10,
        response_format: 'raw_json',
      },
    },
  };

  it('selects the first available profile after probing real command health', () => {
    const status = inspectLlmResolution('distill', policy as any, {
      userTools: {},
      isCommandAvailable: (command) => ({
        available: command !== 'claude',
        reason: command === 'claude' ? 'broken binary' : undefined,
      }),
    });

    expect(status.selectedProfile).toBe('standard');
    expect(status.selectedCommand).toBe('gemini');
    expect(status.checkedProfiles[0]?.available).toBe(false);
    expect(status.checkedProfiles[0]?.reason).toContain('broken binary');

    const profile = resolveLlmConfig('distill', policy as any, {
      userTools: {},
      isCommandAvailable: (command) => ({
        available: command !== 'claude',
        reason: command === 'claude' ? 'broken binary' : undefined,
      }),
    });

    expect(profile.command).toBe('gemini');
  });

  it('throws a clear error when no real backend is usable', () => {
    expect(() =>
      resolveLlmConfig('distill', policy as any, {
        userTools: {},
        isCommandAvailable: () => ({ available: false, reason: 'unavailable' }),
      }),
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

    expect(status.selectedProfile).toBe('light');
    expect(status.selectedCommand).toBe('codex');
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
      z.object({ answer: z.number() }),
    );

    expect(result).toEqual({ answer: 11 });
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
        isCommandAvailable: (command) => ({ available: command === 'heavy-cmd' || command === 'standard-cmd' }),
        policy: {
          default_profile: 'heavy',
          profiles: {
            heavy: { command: 'heavy-cmd', args: [], adapter: 'quota-first' },
            standard: { command: 'standard-cmd', args: [], adapter: 'quota-second' },
          },
        },
      },
    );

    expect(result).toEqual({ answer: 11 });
    expect(calls).toEqual(['heavy', 'standard']);
  });
});

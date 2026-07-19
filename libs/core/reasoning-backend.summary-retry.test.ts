import { afterEach, describe, expect, it } from 'vitest';
import {
  DELEGATION_SUMMARY_MIN_CHARS,
  STRUCTURED_DELEGATION_PROMPT_HEADER,
  buildDelegationSummaryContinuationPrompt,
  buildFailoverReasoningBackend,
  delegationSummaryRetryEnabled,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';

function makeBackend(
  name: string,
  delegateTask: ReasoningBackend['delegateTask']
): ReasoningBackend {
  return { ...stubReasoningBackend, name, delegateTask };
}

const LONG_REPORT = 'A detailed report with concrete evidence. '.repeat(10);

describe('KC-06 delegation summary min-length retry', () => {
  afterEach(() => {
    delete process.env.KYBERION_DELEGATION_SUMMARY_RETRY;
  });

  it('retries a too-brief report exactly once and returns the second result as-is', async () => {
    const prompts: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        backend: makeBackend('fake', async (instruction) => {
          prompts.push(instruction);
          return 'too short';
        }),
      },
    ]);

    const result = await backend.delegateTask('Write the migration report.');
    // Still short after the continuation — passes through unconditionally.
    expect(result).toBe('too short');
    expect(prompts).toHaveLength(2);
    // The continuation prompt embeds the original instruction and the brief result.
    expect(prompts[1]).toContain('Write the migration report.');
    expect(prompts[1]).toContain('too short');
    expect(prompts[1]).toContain('too brief');
  });

  it('does not retry when the report meets the minimum length', async () => {
    const prompts: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        backend: makeBackend('fake', async (instruction) => {
          prompts.push(instruction);
          return LONG_REPORT;
        }),
      },
    ]);

    expect(LONG_REPORT.trim().length).toBeGreaterThanOrEqual(DELEGATION_SUMMARY_MIN_CHARS);
    await expect(backend.delegateTask('Write the migration report.')).resolves.toBe(LONG_REPORT);
    expect(prompts).toHaveLength(1);
  });

  it('never retries the stub backend (short deterministic strings are its contract)', async () => {
    const prompts: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        backend: makeBackend('stub', async (instruction) => {
          prompts.push(instruction);
          return '[STUB] short';
        }),
      },
    ]);

    await expect(backend.delegateTask('Do work.')).resolves.toBe('[STUB] short');
    expect(prompts).toHaveLength(1);
  });

  it('is opt-out via KYBERION_DELEGATION_SUMMARY_RETRY=0', async () => {
    process.env.KYBERION_DELEGATION_SUMMARY_RETRY = '0';
    expect(delegationSummaryRetryEnabled()).toBe(false);
    const prompts: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        backend: makeBackend('fake', async (instruction) => {
          prompts.push(instruction);
          return 'short';
        }),
      },
    ]);

    await expect(backend.delegateTask('Do work.')).resolves.toBe('short');
    expect(prompts).toHaveLength(1);
  });

  it('skips structured delegations, which own their schema-validation retry loop', async () => {
    const prompts: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        backend: makeBackend('fake', async (instruction) => {
          prompts.push(instruction);
          return '{"ok":true}';
        }),
      },
    ]);

    const structuredPrompt = `${STRUCTURED_DELEGATION_PROMPT_HEADER}\nSchema: {}`;
    await expect(backend.delegateTask(structuredPrompt)).resolves.toBe('{"ok":true}');
    expect(prompts).toHaveLength(1);
  });

  it('builds a continuation prompt asking for concrete evidence', () => {
    const prompt = buildDelegationSummaryContinuationPrompt('original task', 'brief');
    expect(prompt).toContain('original task');
    expect(prompt).toContain('brief');
    expect(prompt).toContain('evidence');
  });
});

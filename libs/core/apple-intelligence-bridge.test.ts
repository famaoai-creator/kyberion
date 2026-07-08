import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import {
  appleFmPrompt,
  classifyLocallyWithAppleFm,
  probeAppleIntelligence,
  recognizeImageLocallyWithAppleVision,
  resetAppleIntelligenceAvailabilityCache,
  setAfmRunnerForTests,
  summarizeLocallyWithAppleFm,
  type AfmRunner,
} from './apple-intelligence-bridge.js';

const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];

function installRunner(
  respond: (command: string, args: string[]) => { ok: boolean; stdout: string; stderr: string }
) {
  const runner: AfmRunner = async (command, args, options) => {
    calls.push({ command, args, stdin: options.stdin });
    return respond(command, args);
  };
  setAfmRunnerForTests(runner);
}

describe('apple intelligence bridge', () => {
  beforeEach(() => {
    calls.length = 0;
    resetAppleIntelligenceAvailabilityCache();
    delete process.env.KYBERION_APPLE_FM;
  });

  afterEach(() => {
    setAfmRunnerForTests(null);
    delete process.env.KYBERION_APPLE_FM;
  });

  it('is disabled via KYBERION_APPLE_FM=0 without touching any process', async () => {
    process.env.KYBERION_APPLE_FM = '0';
    installRunner(() => ({ ok: true, stdout: '{"available":true}', stderr: '' }));
    const availability = await probeAppleIntelligence();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('disabled');
    expect(calls).toHaveLength(0);
    expect(await appleFmPrompt('hello')).toBeNull();
  });

  it('degrades to null on non-Apple platforms and probe failures', async () => {
    installRunner(() => ({ ok: false, stdout: '', stderr: 'boom' }));
    const availability = await probeAppleIntelligence();
    expect(availability.available).toBe(false);
    expect(await summarizeLocallyWithAppleFm('text')).toBeNull();
  });

  it('caches availability and routes prompt through the afm binary', async () => {
    if (process.platform !== 'darwin') return; // platform gate short-circuits before the runner
    installRunner((command, args) => {
      if (args[0] === 'availability') return { ok: true, stdout: '{"available":true}', stderr: '' };
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      return { ok: true, stdout: 'ローカル要約です。', stderr: '' };
    });
    const first = await probeAppleIntelligence();
    expect(first.available).toBe(true);
    const probeCalls = calls.length;
    await probeAppleIntelligence();
    expect(calls.length).toBe(probeCalls); // cached — no extra probe

    const answer = await appleFmPrompt('要約して', { instructions: '簡潔に' });
    expect(answer).toBe('ローカル要約です。');
    const promptCall = calls.at(-1)!;
    expect(promptCall.args[0]).toBe('prompt');
    expect(promptCall.args).toContain('--instructions');
    expect(promptCall.stdin).toBe('要約して');
  });

  it('vision parses the last JSON line, tolerating OS loader noise on stdout', async () => {
    if (process.platform !== 'darwin') return;
    installRunner((command, args) => {
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'vision') {
        return {
          ok: true,
          stdout:
            'Unable to find a valid E5 in provided path ...\n' +
            '{"text":"KYBERION\\nheadline","labels":[{"label":"document","confidence":0.44}]}\n',
          stderr: '',
        };
      }
      return { ok: true, stdout: '{"available":true}', stderr: '' };
    });
    const result = await recognizeImageLocallyWithAppleVision('/tmp/x.png');
    expect(result?.text).toContain('KYBERION');
    expect(result?.labels[0]).toEqual({ label: 'document', confidence: 0.44 });
  });

  it('classification embeds the task in the prompt and validates the category', async () => {
    if (process.platform !== 'darwin') return;
    installRunner((command, args) => {
      if (args[0] === 'availability') return { ok: true, stdout: '{"available":true}', stderr: '' };
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      return { ok: true, stdout: 'DOCUMENT_PRODUCTION\n', stderr: '' };
    });
    const category = await classifyLocallyWithAppleFm('レポートを作って', [
      'document_production',
      'code_change',
    ]);
    expect(category).toBe('document_production');
    const promptCall = calls.at(-1)!;
    expect(promptCall.stdin).toContain('カテゴリ: document_production / code_change');
    // hallucinated category → null, not a guess
    installRunner((command, args) => {
      if (args[0] === 'availability') return { ok: true, stdout: '{"available":true}', stderr: '' };
      return { ok: true, stdout: 'something_else', stderr: '' };
    });
    resetAppleIntelligenceAvailabilityCache();
    expect(await classifyLocallyWithAppleFm('x', ['a', 'b'])).toBeNull();
  });
});

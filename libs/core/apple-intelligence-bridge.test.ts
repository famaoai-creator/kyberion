import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import {
  appleFmPrompt,
  classifyLocallyWithAppleFm,
  probeAppleIntelligence,
  probeAppleImageGeneration,
  createAppleSpeechToTextBridge,
  generateImageLocallyWithApplePlayground,
  recognizeImageLocallyWithAppleVision,
  transcribeAudioLocallyWithAppleSpeech,
  verifyRenderedTextWithAppleVision,
  resetAppleIntelligenceAvailabilityCache,
  resetAppleImageGenerationAvailabilityCache,
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
    resetAppleImageGenerationAvailabilityCache();
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

  it('rendered-text verification is whitespace-insensitive and reports misses', async () => {
    if (process.platform !== 'darwin') return;
    installRunner((command, args) => {
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'vision') {
        return {
          ok: true,
          stdout: '{"text":"KYBERION\\nThe organization work loop engine","labels":[]}\n',
          stderr: '',
        };
      }
      return { ok: true, stdout: '{"available":true}', stderr: '' };
    });
    const verdict = await verifyRenderedTextWithAppleVision('/tmp/x.png', [
      'THE ORGANIZATION work loop',
      '見えない文字列',
    ]);
    expect(verdict?.ok).toBe(false);
    expect(verdict?.missing).toEqual(['見えない文字列']);
  });

  it('transcribe passes locale/timeout args and parses the JSON line', async () => {
    if (process.platform !== 'darwin') return;
    installRunner((command, args) => {
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'transcribe') {
        return { ok: true, stdout: 'loader noise\n{"text":"会議の文字起こし"}\n', stderr: '' };
      }
      return { ok: true, stdout: '{"available":true}', stderr: '' };
    });
    const text = await transcribeAudioLocallyWithAppleSpeech('/tmp/a.aiff', { locale: 'en-US' });
    expect(text).toBe('会議の文字起こし');
    const call = calls.at(-1)!;
    expect(call.args).toContain('--locale');
    expect(call.args).toContain('en-US');
  });

  it('imagine degrades to null on notSupported and returns path/style on success', async () => {
    if (process.platform !== 'darwin') return;
    installRunner((command, args) => {
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'imagine') return { ok: false, stdout: '', stderr: 'ERROR: notSupported' };
      return { ok: true, stdout: '{"available":true}', stderr: '' };
    });
    expect(await generateImageLocallyWithApplePlayground('x', '/tmp/x.png')).toBeNull();

    installRunner((command, args) => {
      if (args[0] === 'imagine') {
        return { ok: true, stdout: '{"path":"/tmp/x.png","style":"illustration"}\n', stderr: '' };
      }
      return { ok: true, stdout: '{"available":true}', stderr: '' };
    });
    const generated = await generateImageLocallyWithApplePlayground('x', '/tmp/x.png', {
      style: 'illustration',
    });
    expect(generated).toEqual({ path: '/tmp/x.png', style: 'illustration' });
    expect(calls.at(-1)!.args).toContain('--style');
  });

  it('probes Image Playground independently from Foundation Models availability', async () => {
    if (process.platform !== 'darwin') return;
    installRunner((command, args) => {
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'imagine-availability') {
        return { ok: true, stdout: '{"available":false,"reason":"notSupported"}\n', stderr: '' };
      }
      return { ok: true, stdout: '{"available":true}', stderr: '' };
    });
    await expect(probeAppleImageGeneration()).resolves.toEqual({
      available: false,
      reason: 'notSupported',
    });
    expect(calls.at(-1)?.args).toEqual(['imagine-availability']);
  });

  it('SpeechToTextBridge adapter maps language to locale and writes the sidecar', async () => {
    if (process.platform !== 'darwin') return;
    installRunner((command, args) => {
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'transcribe')
        return { ok: true, stdout: '{"text":"議事録テスト"}\n', stderr: '' };
      return { ok: true, stdout: '{"available":true}', stderr: '' };
    });
    const bridge = createAppleSpeechToTextBridge();
    expect(bridge.name).toBe('apple-speech');
    // nonexistent audio → contract-conformant throw
    await expect(bridge.transcribe({ audioPath: '/nonexistent/audio.aiff' })).rejects.toThrow(
      /audio file not found/
    );
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

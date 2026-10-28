import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import * as secureIo from './secure-io.js';
import * as platform from './platform.js';
import { getSpeechToTextBridges, resetSpeechToTextBridge } from './voice/speech-to-text-bridge.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

vi.mock('./core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import {
  probeAppleSpeechAvailability,
  normalizeAppleSpeechAvailability,
  _resetAppleSpeechAvailabilityCacheForTests,
  installAppleSpeechToTextBridgeIfAvailable,
  appleCoreAiRun,
  appleFmEvaluate,
  appleFmPrompt,
  appleFmPromptWithImage,
  appleFmSessionRequests,
  classifyLocallyWithAppleFm,
  gateAppleLane,
  normalizeAppleIntelligenceCapabilities,
  normalizeApplePccProbe,
  probeAppleCoreAi,
  probeAppleEvaluations,
  probeAppleIntelligence,
  probeAppleIntelligenceCapabilities,
  probeAppleImageGeneration,
  probeApplePcc,
  createAppleSpeechToTextBridge,
  generateImageLocallyWithApplePlayground,
  recognizeImageLocallyWithAppleVision,
  transcribeAudioLocallyWithAppleSpeech,
  verifyRenderedTextWithAppleVision,
  _resetAppleIntelligenceAvailabilityCacheForTests,
  _resetAppleImageGenerationAvailabilityCacheForTests,
  _resetAppleIntelligenceCapabilitiesCacheForTests,
  _resetApplePccProbeCacheForTests,
  _resetAppleCoreAiAvailabilityCacheForTests,
  _resetAppleEvaluationsProbeCacheForTests,
  setAfmRunnerForTests,
  summarizeLocallyWithAppleFm,
  normalizeAppleImageGenerationAvailability,
  normalizeAppleImageGenerationResult,
  normalizeAppleIntelligenceAvailability,
  normalizeAppleVisionResult,
  type AfmRunner,
} from './apple-intelligence-bridge.js';

const calls: Array<{ command: string; args: string[]; stdin?: string; timeoutMs: number }> = [];
const TEST_AUDIO = pathResolver.sharedTmp('apple-intelligence-bridge-test/input.wav');

function installRunner(
  respond: (command: string, args: string[]) => { ok: boolean; stdout: string; stderr: string }
) {
  const runner: AfmRunner = async (command, args, options) => {
    calls.push({ command, args, stdin: options.stdin, timeoutMs: options.timeoutMs });
    return respond(command, args);
  };
  setAfmRunnerForTests(runner);
}

describe('apple intelligence bridge', () => {
  beforeEach(() => {
    safeMkdir(path.dirname(TEST_AUDIO), { recursive: true });
    safeWriteFile(TEST_AUDIO, 'native fixture');
    calls.length = 0;
    _resetAppleIntelligenceAvailabilityCacheForTests();
    _resetAppleImageGenerationAvailabilityCacheForTests();
    delete process.env.KYBERION_APPLE_FM;
  });

  afterEach(() => {
    setAfmRunnerForTests(null);
    safeRmSync(pathResolver.sharedTmp('apple-intelligence-bridge-test'), {
      recursive: true,
      force: true,
    });
    delete process.env.KYBERION_APPLE_FM;
  });

  it('normalizes external availability, vision, and image result shapes', () => {
    expect(normalizeAppleIntelligenceAvailability([])).toBeUndefined();
    expect(normalizeAppleIntelligenceAvailability({ available: 'true' })).toBeUndefined();
    expect(
      normalizeAppleIntelligenceAvailability({ available: false, reason: 'notSupported' })
    ).toEqual({ available: false, reason: 'notSupported' });
    expect(
      normalizeAppleVisionResult({
        text: 'headline',
        labels: [
          { label: 'document', confidence: 0.44 },
          { label: 'bad', confidence: 'x' },
        ],
      })
    ).toEqual({ text: 'headline', labels: [{ label: 'document', confidence: 0.44 }] });
    expect(normalizeAppleVisionResult({ text: 'headline', labels: [] })).toEqual({
      text: 'headline',
      labels: [],
    });
    expect(normalizeAppleImageGenerationAvailability({ available: 1 })).toBeUndefined();
    expect(
      normalizeAppleImageGenerationResult({ path: '/tmp/out.png', style: 'illustration' })
    ).toEqual({
      path: '/tmp/out.png',
      style: 'illustration',
    });
    expect(normalizeAppleImageGenerationResult({ path: 42 })).toBeUndefined();
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
    const result = await recognizeImageLocallyWithAppleVision(TEST_AUDIO);
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
    const verdict = await verifyRenderedTextWithAppleVision(TEST_AUDIO, [
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
    safeMkdir(pathResolver.sharedTmp('apple-intelligence-bridge-test'), { recursive: true });
    safeWriteFile(TEST_AUDIO, 'fake-audio');
    const bridge = createAppleSpeechToTextBridge();
    expect(bridge.name).toBe('apple-speech');
    const result = await bridge.transcribe({ audioPath: TEST_AUDIO, language: 'ja' });
    expect(result.language).toBe('ja-JP');
    expect(calls.find((call) => call.args[0] === 'transcribe')?.args).toContain('ja-JP');
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
    _resetAppleIntelligenceAvailabilityCacheForTests();
    expect(await classifyLocallyWithAppleFm('x', ['a', 'b'])).toBeNull();
  });
});

const CAPABILITIES_MATRIX_272 = JSON.stringify({
  os: { major: 27, minor: 2, patch: 0 },
  model: { available: true, reason: '' },
  lanes: {
    text: true,
    vision_ocr: true,
    speech: true,
    imagine: null,
    multimodal: true,
    dynamic_profiles: true,
    pcc: null,
    coreai: true,
    shortcuts: true,
  },
});

function install272Runner(
  extra?: (
    command: string,
    args: string[]
  ) => { ok: boolean; stdout: string; stderr: string } | undefined
) {
  installRunner((command, args) => {
    if (args[0] === 'capabilities')
      return { ok: true, stdout: `${CAPABILITIES_MATRIX_272}\n`, stderr: '' };
    if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
    return extra?.(command, args) ?? { ok: true, stdout: '', stderr: '' };
  });
}

describe('apple intelligence 27.2 lanes', () => {
  beforeEach(() => {
    calls.length = 0;
    _resetAppleIntelligenceAvailabilityCacheForTests();
    _resetAppleImageGenerationAvailabilityCacheForTests();
    _resetAppleIntelligenceCapabilitiesCacheForTests();
    _resetApplePccProbeCacheForTests();
    _resetAppleCoreAiAvailabilityCacheForTests();
    _resetAppleEvaluationsProbeCacheForTests();
    delete process.env.KYBERION_APPLE_FM;
  });

  afterEach(() => {
    setAfmRunnerForTests(null);
    delete process.env.KYBERION_APPLE_FM;
  });

  it('normalizes the capability matrix strictly', () => {
    const happy = normalizeAppleIntelligenceCapabilities({
      os: { major: 27, minor: 2, patch: 0 },
      model: { available: true, reason: '' },
      lanes: {
        text: true,
        vision_ocr: true,
        speech: true,
        imagine: null,
        multimodal: true,
        dynamic_profiles: true,
        pcc: null,
        coreai: true,
        shortcuts: true,
      },
    });
    expect(happy?.os).toEqual({ major: 27, minor: 2, patch: 0 });
    expect(happy?.is_27_or_later).toBe(true);
    expect(happy?.lanes.multimodal).toBe(true);
    expect(happy?.lanes.imagine).toBeNull();
    expect(happy?.lanes.pcc).toBeNull();
    const parsed = normalizeAppleIntelligenceCapabilities({
      os: { major: 26, minor: 3, patch: 1 },
      model: { available: false, reason: 'deviceNotEligible' },
      lanes: {
        text: false,
        vision_ocr: true,
        speech: true,
        imagine: false,
        multimodal: false,
        dynamic_profiles: false,
        pcc: false,
        coreai: false,
        shortcuts: true,
      },
    });
    expect(parsed).toBeDefined();
    expect(parsed!.os).toEqual({ major: 26, minor: 3, patch: 1 });
    expect(parsed!.is_27_or_later).toBe(false);
    expect(parsed!.lanes.multimodal).toBe(false);
    expect(parsed!.model_reason).toBe('deviceNotEligible');
    // boolean lane with null → whole matrix unparseable
    expect(
      normalizeAppleIntelligenceCapabilities({
        os: { major: 27, minor: 0, patch: 0 },
        lanes: {
          text: null,
          vision_ocr: true,
          speech: true,
          imagine: null,
          multimodal: true,
          dynamic_profiles: true,
          pcc: null,
          coreai: true,
          shortcuts: true,
        },
      })
    ).toBeUndefined();
    // live-probe lane with a non-boolean non-null value → unparseable
    expect(
      normalizeAppleIntelligenceCapabilities({
        os: { major: 27, minor: 0, patch: 0 },
        lanes: {
          text: true,
          vision_ocr: true,
          speech: true,
          imagine: 'yes',
          multimodal: true,
          dynamic_profiles: true,
          pcc: null,
          coreai: true,
          shortcuts: true,
        },
      })
    ).toBeUndefined();
  });

  it('caches the capability matrix and degrades on failure', async () => {
    if (process.platform !== 'darwin') return;
    installRunner(() => ({ ok: true, stdout: `${CAPABILITIES_MATRIX_272}\n`, stderr: '' }));
    const caps = await probeAppleIntelligenceCapabilities();
    expect(caps?.os.major).toBe(27);
    expect(caps?.lanes.multimodal).toBe(true);
    expect(caps?.lanes.imagine).toBeNull();
    const probeCalls = calls.length;
    await probeAppleIntelligenceCapabilities();
    expect(calls.length).toBe(probeCalls); // cached

    _resetAppleIntelligenceCapabilitiesCacheForTests();
    installRunner(() => ({ ok: false, stdout: '', stderr: 'boom' }));
    expect(await probeAppleIntelligenceCapabilities()).toBeNull();
    expect(await gateAppleLane('multimodal')).toEqual({
      available: false,
      reason: 'capability matrix unavailable (probe failed)',
    });
  });

  it('is disabled via KYBERION_APPLE_FM=0 without touching any process', async () => {
    process.env.KYBERION_APPLE_FM = '0';
    installRunner(() => ({ ok: true, stdout: CAPABILITIES_MATRIX_272, stderr: '' }));
    expect(await probeAppleIntelligenceCapabilities()).toBeNull();
    expect(calls).toHaveLength(0);
    const gate = await gateAppleLane('pcc');
    expect(gate.available).toBe(false);
    expect(gate.reason).toContain('disabled');
  });

  it('gates boolean lanes through the matrix and live lanes through their probes', async () => {
    if (process.platform !== 'darwin') return;
    // multimodal true in the matrix → available
    install272Runner((_command, args) =>
      args[0] === 'coreai-availability'
        ? { ok: true, stdout: '{"available":true}\n', stderr: '' }
        : undefined
    );
    expect(await gateAppleLane('multimodal')).toEqual({ available: true });
    expect(await gateAppleLane('dynamic_profiles')).toEqual({ available: true });
    expect(await gateAppleLane('coreai')).toEqual({ available: true });

    // pcc null in the matrix → routed to the live probe
    install272Runner((command, args) => {
      if (args[0] === 'pcc-availability')
        return {
          ok: true,
          stdout:
            '{"available":false,"class":"device_not_eligible","reason":"deviceNotEligible","quota":null}\n',
          stderr: '',
        };
      return { ok: true, stdout: '', stderr: '' };
    });
    const pccGate = await gateAppleLane('pcc');
    expect(pccGate.available).toBe(false);
    expect(pccGate.reason).toContain('deviceNotEligible');

    // imagine null in the matrix → routed to the Image Playground probe
    install272Runner((command, args) => {
      if (args[0] === 'imagine-availability')
        return { ok: true, stdout: '{"available":false,"reason":"notSupported"}\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    });
    const imagineGate = await gateAppleLane('imagine');
    expect(imagineGate.available).toBe(false);
    expect(imagineGate.reason).toBe('notSupported');
  });

  it('routes multimodal prompts through --image under the lane gate', async () => {
    if (process.platform !== 'darwin') return;
    // matrix says multimodal=false → gate refuses before any process
    installRunner(() => ({
      ok: true,
      stdout: `${JSON.stringify({
        os: { major: 26, minor: 4, patch: 0 },
        model: { available: true, reason: '' },
        lanes: {
          text: true,
          vision_ocr: true,
          speech: true,
          imagine: null,
          multimodal: false,
          dynamic_profiles: false,
          pcc: null,
          coreai: false,
          shortcuts: true,
        },
      })}\n`,
      stderr: '',
    }));
    expect(await appleFmPromptWithImage('what is this?', '/tmp/x.png')).toBeNull();
    expect(calls.find((call) => call.args[0] === 'prompt')).toBeUndefined();

    _resetAppleIntelligenceCapabilitiesCacheForTests();
    install272Runner(() => ({ ok: true, stdout: '画像には図形があります。\n', stderr: '' }));
    safeMkdir(pathResolver.sharedTmp('apple-intelligence-bridge-test'), { recursive: true });
    safeWriteFile(TEST_AUDIO, 'image fixture');
    const answer = await appleFmPromptWithImage('what is this?', TEST_AUDIO, {
      instructions: 'be brief',
      timeoutMs: 90_000,
    });
    expect(answer).toBe('画像には図形があります。');
    const promptCall = calls.find((call) => call.args[0] === 'prompt')!;
    expect(promptCall.args).toContain('--image');
    expect(promptCall.args[promptCall.args.indexOf('--image') + 1]).toBe(TEST_AUDIO);
    expect(promptCall.stdin).toBe('what is this?');
  });

  it('parses session JSONL responses and tolerates loader noise', async () => {
    if (process.platform !== 'darwin') return;
    install272Runner(() => ({
      ok: true,
      stdout:
        'loader noise\n{"index":0,"content":"こんにちは"}\n{"index":1,"content":"さようなら"}\n',
      stderr: '',
    }));
    const responses = await appleFmSessionRequests([
      { prompt: 'hello', instructions: 'answer in Japanese', tools: ['ocr'] },
      { prompt: 'goodbye', instructions: 'poetic' },
    ]);
    expect(responses).toHaveLength(2);
    expect(responses![0]).toEqual({ index: 0, content: 'こんにちは' });
    expect(responses![1]).toEqual({ index: 1, content: 'さようなら' });
    const sessionCall = calls.find((call) => call.args[0] === 'session')!;
    const stdinLines = String(sessionCall.stdin).trim().split('\n');
    expect(JSON.parse(stdinLines[0])).toEqual({
      prompt: 'hello',
      instructions: 'answer in Japanese',
      tools: ['ocr'],
    });
    expect(JSON.parse(stdinLines[1])).toEqual({ prompt: 'goodbye', instructions: 'poetic' });
  });

  it('degrades sessions to null when the lane is gated', async () => {
    process.env.KYBERION_APPLE_FM = '0';
    installRunner(() => ({ ok: true, stdout: '', stderr: '' }));
    expect(await appleFmSessionRequests([{ prompt: 'x' }])).toBeNull();
    expect(await appleFmSessionRequests([])).toBeNull(); // gate wins over the empty-list shortcut
    expect(calls).toHaveLength(0);
  });

  it('normalizes PCC probe output with quota classification', async () => {
    if (process.platform !== 'darwin') return;
    install272Runner((command, args) => {
      if (args[0] === 'pcc-availability')
        return {
          ok: true,
          stdout:
            '{"available":true,"class":"available","reason":"","quota":{"limit_reached":false,"approaching":true,"reset_date":"2026-10-30"}}\n',
          stderr: '',
        };
      return { ok: true, stdout: '', stderr: '' };
    });
    const probe = await probeApplePcc();
    expect(probe.available).toBe(true);
    expect(probe.class).toBe('available');
    expect(probe.quota).toEqual({
      limit_reached: false,
      approaching: true,
      reset_date: '2026-10-30',
    });
    const cachedCalls = calls.length;
    await probeApplePcc();
    expect(calls.length).toBe(cachedCalls); // cached

    expect(normalizeApplePccProbe({ available: 'yes', class: 'available' })).toBeUndefined();
    expect(normalizeApplePccProbe({ available: true, class: 'weird' })?.class).toBe(
      'unavailable_other'
    );
    expect(normalizeApplePccProbe({ available: false, class: 'os_too_old' })?.class).toBe(
      'os_too_old'
    );
  });

  it('probes Core AI availability and gates runs', async () => {
    if (process.platform !== 'darwin') return;
    install272Runner((command, args) => {
      if (args[0] === 'coreai-availability')
        return { ok: true, stdout: '{"available":true}\n', stderr: '' };
      if (args[0] === 'coreai') return { ok: true, stdout: '{"output":[1.5,2.5,3]}\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    });
    const availability = await probeAppleCoreAi();
    expect(availability.available).toBe(true);
    safeMkdir(pathResolver.sharedTmp('apple-intelligence-bridge-test'), { recursive: true });
    safeWriteFile(TEST_AUDIO, 'model fixture');
    const output = await appleCoreAiRun(
      TEST_AUDIO,
      'main',
      { input: { shape: [2], values: [1, 2] } },
      'output'
    );
    expect(output).toEqual({ output: [1.5, 2.5, 3] });

    // gated: matrix unavailable → run refuses before spawning
    _resetAppleIntelligenceCapabilitiesCacheForTests();
    _resetAppleCoreAiAvailabilityCacheForTests();
    installRunner(() => ({ ok: false, stdout: '', stderr: 'no swiftc' }));
    expect(await appleCoreAiRun('/models/x.aimodel', 'main', {}, 'output')).toBeNull();
  });

  it('probes the Evaluations toolchain gate honestly', async () => {
    if (process.platform !== 'darwin') return;
    // 27.2 matrix + failing compile probe → unavailable with toolchain reason
    installRunner((command, args) => {
      if (args[0] === 'capabilities')
        return { ok: true, stdout: `${CAPABILITIES_MATRIX_272}\n`, stderr: '' };
      if (command === 'swiftc')
        return args.some((arg) => arg.endsWith('evaluations-probe.swift'))
          ? { ok: false, stdout: '', stderr: "error: no such module 'Evaluations'" }
          : { ok: true, stdout: '', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    });
    const probe = await probeAppleEvaluations();
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain('toolchain');
    expect(await appleFmEvaluate('active/shared/tmp/ds.jsonl')).toBeNull();
    // matrix absent → os gate reason
    _resetAppleIntelligenceCapabilitiesCacheForTests();
    _resetAppleEvaluationsProbeCacheForTests();
    installRunner(() => ({ ok: false, stdout: '', stderr: 'boom' }));
    const osGate = await probeAppleEvaluations();
    expect(osGate).toEqual({ available: false, reason: 'requires macOS 27+' });
  });
  it('rejects duplicate, partial, out-of-range and empty session responses', async () => {
    if (process.platform !== 'darwin') return;
    for (const lines of [
      [
        { index: 0, content: 'a' },
        { index: 0, content: 'b' },
      ],
      [{ index: 0, content: 'a' }],
      [
        { index: 0, content: 'a' },
        { index: 2, content: 'b' },
      ],
      [{ index: 0, content: 'a' }, { index: 1 }],
      [
        { index: 0.5, content: 'a' },
        { index: 1, content: 'b' },
      ],
    ]) {
      install272Runner(() => ({
        ok: true,
        stdout: lines.map((line) => JSON.stringify(line)).join('\n'),
        stderr: '',
      }));
      expect(await appleFmSessionRequests([{ prompt: 'a' }, { prompt: 'b' }])).toBeNull();
    }
  });

  it('denies inaccessible native inputs before inference', async () => {
    install272Runner();
    expect(await appleFmPromptWithImage('describe', '/etc/passwd')).toBeNull();
    expect(await appleCoreAiRun('/etc/passwd', 'main', {}, 'output')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid tensors without running inference', async () => {
    safeMkdir(pathResolver.sharedTmp('apple-intelligence-bridge-test'), { recursive: true });
    safeWriteFile(TEST_AUDIO, 'model fixture');
    install272Runner();
    for (const tensor of [
      { shape: [2], values: [1] },
      { shape: [-1], values: [1] },
      { shape: [1.5], values: [1] },
      { shape: [1], values: [Infinity] },
      { shape: [1], values: [1e100] },
    ])
      expect(await appleCoreAiRun(TEST_AUDIO, 'main', { input: tensor }, 'output')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('uses the Core AI runtime probe even when the matrix advertises support', async () => {
    if (process.platform !== 'darwin') return;
    install272Runner((_command, args) =>
      args[0] === 'coreai-availability'
        ? { ok: true, stdout: '{"available":false,"reason":"framework missing"}', stderr: '' }
        : undefined
    );
    expect(await gateAppleLane('coreai')).toEqual({
      available: false,
      reason: 'framework missing',
    });
  });

  it('does not advertise an executable Evaluations lane when import succeeds', async () => {
    if (process.platform !== 'darwin') return;
    install272Runner();
    const gate = await gateAppleLane('evaluations');
    expect(gate.available).toBe(false);
    expect(gate.reason).toContain('not implemented');
  });

  it('degrades rejected native process launches without throwing', async () => {
    if (process.platform !== 'darwin') return;
    setAfmRunnerForTests(async () => {
      throw new Error('spawn denied');
    });
    expect(await gateAppleLane('coreai')).toMatchObject({ available: false });
    expect(await probeAppleIntelligenceCapabilities()).toBeNull();
  });
  it('honors opt-out after successful probes have filled their caches', async () => {
    if (process.platform !== 'darwin') return;
    install272Runner((_command, args) =>
      args[0] === 'pcc-availability'
        ? { ok: true, stdout: '{"available":true,"class":"available"}', stderr: '' }
        : { ok: true, stdout: '{"available":true}', stderr: '' }
    );
    expect((await probeAppleIntelligence()).available).toBe(true);
    expect((await probeAppleImageGeneration()).available).toBe(true);
    expect(await probeAppleIntelligenceCapabilities()).not.toBeNull();
    expect((await probeApplePcc()).available).toBe(true);
    expect((await probeAppleCoreAi()).available).toBe(true);
    expect((await probeAppleEvaluations()).reason).toContain('not implemented');
    const count = calls.length;
    process.env.KYBERION_APPLE_FM = '0';
    expect(await probeAppleIntelligenceCapabilities()).toBeNull();
    for (const probe of [
      probeAppleIntelligence,
      probeAppleImageGeneration,
      probeApplePcc,
      probeAppleCoreAi,
      probeAppleEvaluations,
    ]) {
      expect(await probe()).toMatchObject({
        available: false,
        reason: 'disabled via KYBERION_APPLE_FM',
      });
    }
    expect(calls).toHaveLength(count);
  });

  it('rechecks native input after the asynchronous gate', async () => {
    if (process.platform !== 'darwin') return;
    safeMkdir(pathResolver.sharedTmp('apple-intelligence-bridge-test'), { recursive: true });
    safeWriteFile(TEST_AUDIO, 'image fixture');
    installRunner((_command, args) => {
      if (args[0] === 'capabilities') {
        safeRmSync(TEST_AUDIO);
        return { ok: true, stdout: CAPABILITIES_MATRIX_272, stderr: '' };
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    expect(await appleFmPromptWithImage('describe', TEST_AUDIO)).toBeNull();
    expect(calls.some((call) => call.args[0] === 'prompt')).toBe(false);
  });
  it('compiles without requiring the macOS 27 CoreAI framework on older SDKs', async () => {
    if (process.platform !== 'darwin') return;
    const exists = secureIo.safeExistsSync;
    const spy = vi
      .spyOn(secureIo, 'safeExistsSync')
      .mockImplementation((filePath) =>
        String(filePath).endsWith('/apple-intelligence/afm') ? false : exists(filePath)
      );
    try {
      install272Runner();
      await probeAppleIntelligenceCapabilities();
      const compile = calls.find((call) => call.command === 'swiftc');
      expect(compile).toBeDefined();
      expect(compile!.args).not.toContain('CoreAI');
      expect(compile!.args).not.toContain('-weak_framework');
      expect(compile!.args).toContain('arm64-apple-macos26.0');
    } finally {
      spy.mockRestore();
    }
  });

  it('exposes only the overall session timeout on the wire', async () => {
    if (process.platform !== 'darwin') return;
    install272Runner(() => ({ ok: true, stdout: '{"index":0,"content":"ok"}', stderr: '' }));
    const request = { prompt: 'hello', timeout: 1 };
    expect(await appleFmSessionRequests([request], { timeoutMs: 120_000 })).toHaveLength(1);
    const call = calls.find((entry) => entry.args[0] === 'session')!;
    expect(JSON.parse(String(call.stdin).trim())).toEqual({ prompt: 'hello' });
    expect(call.args).toEqual(['session', '--timeout', '120']);
  });
});

describe('independent Apple Speech readiness and exact local classification', () => {
  beforeEach(() => {
    calls.length = 0;
    _resetAppleSpeechAvailabilityCacheForTests();
    _resetAppleIntelligenceAvailabilityCacheForTests();
    resetSpeechToTextBridge();
    vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(true);
    for (const name of [
      'KYBERION_APPLE_FM',
      'KYBERION_STT_COMMAND',
      'KYBERION_FLUID_AUDIO_STT_COMMAND',
    ])
      vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    setAfmRunnerForTests(null);
    resetSpeechToTextBridge();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  function speechRunner(assetStatus = 'installed') {
    installRunner((command, args) => {
      if (command === 'swiftc') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'availability') {
        return {
          ok: true,
          stdout: '{"available":false,"reason":"text model disabled"}',
          stderr: '',
        };
      }
      if (args[0] === 'speech-availability') {
        return {
          ok: true,
          stdout:
            'Speech loader diagnostic\n' +
            JSON.stringify({
              available: assetStatus === 'installed',
              locale: args[args.indexOf('--locale') + 1],
              asset_status: assetStatus,
              ...(assetStatus === 'installed' ? {} : { reason: 'speech assets not ready' }),
            }) +
            '\n',
          stderr: '',
        };
      }
      return { ok: false, stdout: '', stderr: 'unexpected command' };
    });
  }
  it('registers ready speech even when the Foundation Models text model is unavailable', async () => {
    speechRunner();
    expect((await probeAppleIntelligence()).available).toBe(false);
    expect(await installAppleSpeechToTextBridgeIfAvailable()).toBe(true);
    expect(getSpeechToTextBridges().some((bridge) => bridge.name === 'apple-speech')).toBe(true);
    expect(await gateAppleLane('speech')).toEqual({ available: true });
  });
  it.each(['supported', 'downloading', 'unsupported'])(
    'does not register speech with %s assets even when the text model works',
    async (status) => {
      speechRunner(status);
      expect(await installAppleSpeechToTextBridgeIfAvailable()).toBe(false);
      expect(getSpeechToTextBridges().some((bridge) => bridge.name === 'apple-speech')).toBe(false);
      expect(await gateAppleLane('speech')).toMatchObject({
        available: false,
        reason: 'speech assets not ready',
      });
      expect(calls.some((call) => call.args[0] === 'availability')).toBe(false);
    }
  );
  it.each(['KYBERION_STT_COMMAND', 'KYBERION_FLUID_AUDIO_STT_COMMAND'])(
    'keeps an explicit %s ahead of implicit Apple speech',
    async (name) => {
      speechRunner();
      vi.stubEnv(name, 'configured-stt');
      expect(await installAppleSpeechToTextBridgeIfAvailable()).toBe(false);
      expect(calls).toHaveLength(0);
    }
  );
  it('caches negative readiness per locale without reusing it for another locale', async () => {
    speechRunner('supported');
    expect((await probeAppleSpeechAvailability({ locale: 'ja' })).available).toBe(false);
    const count = calls.length;
    expect((await probeAppleSpeechAvailability({ locale: 'ja' })).locale).toBe('ja-JP');
    expect(calls).toHaveLength(count);
    speechRunner();
    expect((await probeAppleSpeechAvailability({ locale: 'en' })).available).toBe(true);
    expect(calls.at(-1)?.args).toEqual(['speech-availability', '--locale', 'en-US']);
  });
  it('reprobes a negative readiness result after the cache expires', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    speechRunner('supported');
    expect((await probeAppleSpeechAvailability({ locale: 'ja' })).available).toBe(false);
    speechRunner();
    clock.mockReturnValue(now + 10 * 60_000 + 1);
    expect((await probeAppleSpeechAvailability({ locale: 'ja' })).available).toBe(true);
  });
  it('honors opt-out after successful readiness and before registration', async () => {
    speechRunner();
    expect((await probeAppleSpeechAvailability({ locale: 'ja' })).available).toBe(true);
    const count = calls.length;
    vi.stubEnv('KYBERION_APPLE_FM', '0');
    expect(await probeAppleSpeechAvailability({ locale: 'ja' })).toMatchObject({
      available: false,
      reason: 'disabled via KYBERION_APPLE_FM',
    });
    expect(await installAppleSpeechToTextBridgeIfAvailable()).toBe(false);
    expect(calls).toHaveLength(count);
  });
  it('degrades malformed readiness and process failure without registering speech', async () => {
    expect(
      normalizeAppleSpeechAvailability({
        available: true,
        locale: 'ja-JP',
        asset_status: 'supported',
      })
    ).toBeUndefined();
    expect(
      normalizeAppleSpeechAvailability({ available: true, locale: '', asset_status: 'installed' })
    ).toBeUndefined();
    installRunner(() => ({ ok: true, stdout: '{"available":true,"locale":"ja-JP"}', stderr: '' }));
    expect((await probeAppleSpeechAvailability({ locale: 'ja' })).available).toBe(false);
    _resetAppleSpeechAvailabilityCacheForTests();
    setAfmRunnerForTests(async () => {
      throw new Error('process denied');
    });
    expect((await probeAppleSpeechAvailability({ locale: 'ja' })).available).toBe(false);
  });
  it('shares the OCR timeout between cold compilation and native recognition', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const exists = secureIo.safeExistsSync;
    vi.spyOn(secureIo, 'safeExistsSync').mockImplementation((filePath) =>
      String(filePath).endsWith('/apple-intelligence/afm') ? false : exists(filePath)
    );
    installRunner((command, args) => {
      if (command === 'swiftc') {
        now += 10;
        return { ok: true, stdout: '', stderr: '' };
      }
      return { ok: true, stdout: '{"text":"fixture","labels":[]}', stderr: '' };
    });
    expect(
      await recognizeImageLocallyWithAppleVision('docs/assets/surfaces/ui-gallery.jpg', {
        timeoutMs: 50,
      })
    ).toMatchObject({ text: 'fixture' });
    expect(calls.find((call) => call.command === 'swiftc')?.timeoutMs).toBe(50);
    expect(calls.find((call) => call.args[0] === 'vision')?.timeoutMs).toBe(40);
  });
  it('does not launch OCR if cold compilation exhausts the total timeout', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const exists = secureIo.safeExistsSync;
    vi.spyOn(secureIo, 'safeExistsSync').mockImplementation((filePath) =>
      String(filePath).endsWith('/apple-intelligence/afm') ? false : exists(filePath)
    );
    installRunner((command) => {
      if (command === 'swiftc') now += 51;
      return { ok: true, stdout: '', stderr: '' };
    });
    expect(
      await recognizeImageLocallyWithAppleVision('docs/assets/surfaces/ui-gallery.jpg', {
        timeoutMs: 50,
      })
    ).toBeNull();
    expect(calls.find((call) => call.command === 'swiftc')?.timeoutMs).toBe(50);
    expect(calls.some((call) => call.args[0] === 'vision')).toBe(false);
  });
  it.each([0, -1, NaN, Infinity])(
    'refuses invalid OCR timeout %s without native work',
    async (timeoutMs) => {
      speechRunner();
      expect(
        await recognizeImageLocallyWithAppleVision('docs/assets/surfaces/ui-gallery.jpg', {
          timeoutMs,
        })
      ).toBeNull();
      expect(calls).toHaveLength(0);
    }
  );

  it('refuses unauthorized or missing native OCR files before launching the bridge', async () => {
    installRunner(() => ({ ok: true, stdout: '{"text":"must not read","labels":[]}', stderr: '' }));
    expect(await recognizeImageLocallyWithAppleVision('/etc/passwd')).toBeNull();
    expect(await recognizeImageLocallyWithAppleVision(TEST_AUDIO + '.missing')).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it('forwards explicit OCR language and retains real line geometry without consulting the text model', async () => {
    const native = {
      text: 'Public fixture',
      labels: [],
      confidence: 96,
      lines: [
        {
          text: 'Public fixture',
          confidence: 96,
          boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        },
      ],
    };
    installRunner((command, args) =>
      command === 'swiftc'
        ? { ok: true, stdout: '', stderr: '' }
        : args[0] === 'vision'
          ? { ok: true, stdout: JSON.stringify(native), stderr: '' }
          : { ok: false, stdout: '', stderr: 'text model must not be consulted' }
    );
    expect(
      await recognizeImageLocallyWithAppleVision('docs/assets/surfaces/ui-gallery.jpg', {
        language: 'jpn+eng',
      })
    ).toEqual(native);
    expect(calls.find((call) => call.args[0] === 'vision')?.args).toContain('jpn+eng');
    expect(calls.some((call) => call.args[0] === 'availability')).toBe(false);
  });

  it('does not probe native speech on unsupported platforms', async () => {
    vi.mocked(platform.isAppleSilicon).mockReturnValue(false);
    speechRunner();
    expect((await probeAppleSpeechAvailability()).available).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it.each([
    'not research',
    'research_report',
    'research / code_change',
    'research\ncode_change',
    '"research"',
  ])('rejects a non-exact category response: %s', async (response) => {
    installRunner((command, args) =>
      command === 'swiftc'
        ? { ok: true, stdout: '', stderr: '' }
        : args[0] === 'availability'
          ? { ok: true, stdout: '{"available":true}', stderr: '' }
          : { ok: true, stdout: response, stderr: '' }
    );
    expect(await classifyLocallyWithAppleFm('fixture', ['research', 'code_change'])).toBeNull();
  });
  it('accepts only the exact matching overlapping label and preserves its declared spelling', async () => {
    installRunner((command, args) =>
      command === 'swiftc'
        ? { ok: true, stdout: '', stderr: '' }
        : args[0] === 'availability'
          ? { ok: true, stdout: '{"available":true}', stderr: '' }
          : { ok: true, stdout: ' RESEARCH_REPORT\n', stderr: '' }
    );
    expect(await classifyLocallyWithAppleFm('fixture', ['research', 'Research_Report'])).toBe(
      'Research_Report'
    );
  });
});

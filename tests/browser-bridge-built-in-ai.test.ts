import { afterEach, describe, expect, it, vi } from 'vitest';

function installBuiltInAi(promptResponse: unknown) {
  const session = {
    prompt: vi.fn(async () => JSON.stringify(promptResponse)),
    destroy: vi.fn(),
  };
  (globalThis as any).__kyberionPiiScrub = (value: unknown) =>
    String(value ?? '').replaceAll('SECRET', '[REDACTED:SECRET]');
  (globalThis as any).LanguageModel = {
    availability: vi.fn(async () => 'available'),
    create: vi.fn(async () => session),
  };
  (globalThis as any).Summarizer = {
    availability: vi.fn(async () => 'unavailable'),
  };
  return session;
}

async function loadAdapter() {
  vi.resetModules();
  await import('../tools/adf-replay-extension/built-in-ai.js');
  return (globalThis as any).KyberionBuiltInAI;
}

describe('Browser Bridge Chrome Built-in AI adapter', () => {
  afterEach(() => {
    delete (globalThis as any).KyberionBuiltInAI;
    delete (globalThis as any).__kyberionPiiScrub;
    delete (globalThis as any).LanguageModel;
    delete (globalThis as any).Summarizer;
    for (const name of ['Translator', 'LanguageDetector', 'Writer', 'Rewriter', 'Proofreader']) {
      delete (globalThis as any)[name];
    }
  });

  it('scrubs page data and returns a non-executable scenario candidate', async () => {
    const session = installBuiltInAi({
      title: '経費申請',
      goal: '経費を申請する SECRET',
      steps: [{ kind: 'click', summary: '申請ボタンを確認する' }],
      variables: [],
      risk: 'high',
      notes: '確認が必要',
    });
    const adapter = await loadAdapter();

    const result = await adapter.extractScenarioCandidate({
      title: '経費 SECRET',
      url: 'https://example.test/app?token=SECRET',
      text: 'ページ本文 SECRET',
    });

    expect(result.candidate.executable).toBe(false);
    expect(result.candidate.review_required).toBe(true);
    expect(result.candidate.goal).toBe('経費を申請する [REDACTED:SECRET]');
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt.mock.calls[0][0]).not.toContain('ページ本文 SECRET');
    expect(session.prompt.mock.calls[0][0]).toContain('[REDACTED:SECRET]');
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not trust an out-of-range repair candidate index', async () => {
    installBuiltInAi({ decision: 'match', candidate_index: 99, reason: '似ている' });
    const adapter = await loadAdapter();

    const result = await adapter.assessTargetCandidates({
      target: { ref: '@button_1', role: 'button', name: '送信', snapshot_hash: 'a'.repeat(64) },
      candidates: [{ role: 'button', name: '送信', text: '送信' }],
      currentSnapshotHash: 'a'.repeat(64),
    });

    expect(result.decision).toBe('match');
    expect(result.candidate_index).toBeNull();
    expect(result.executable).toBe(false);
  });

  it('fails closed when the shared PII scrubber is unavailable', async () => {
    (globalThis as any).LanguageModel = { availability: vi.fn(async () => 'available') };
    (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
    const adapter = await loadAdapter();

    await expect(adapter.summarize('ページ本文')).rejects.toThrow('PII scrubber');
  });

  describe('modernised platform support', () => {
    function stubScrub() {
      (globalThis as any).__kyberionPiiScrub = (value: unknown) =>
        String(value ?? '').replaceAll('SECRET', '[REDACTED:SECRET]');
    }

    function promptSession(overrides: Record<string, unknown> = {}) {
      return {
        prompt: vi.fn(async () => JSON.stringify({ summary: 'ok' })),
        promptStreaming: vi.fn(),
        destroy: vi.fn(),
        ...overrides,
      };
    }

    it('reports a capability matrix with missing APIs as unsupported', async () => {
      (globalThis as any).LanguageModel = { availability: vi.fn(async () => 'downloadable') };
      const adapter = await loadAdapter();

      const matrix = await adapter.availability();

      expect(matrix.prompt).toBe('downloadable');
      expect(matrix.summarizer).toBe('unsupported');
      expect(matrix.translator).toBe('unsupported');
      expect(matrix.languageDetector).toBe('unsupported');
      expect(matrix.writer).toBe('unsupported');
      expect(matrix.rewriter).toBe('unsupported');
      expect(matrix.proofreader).toBe('unsupported');
      expect(matrix.multimodal).toEqual({ image: 'downloadable', audio: 'downloadable' });
    });

    it('turns an availability failure into an error state, not an exception', async () => {
      (globalThis as any).Summarizer = {
        availability: vi.fn(async () => {
          throw new Error('boom');
        }),
      };
      const adapter = await loadAdapter();

      expect((await adapter.availability()).summarizer).toEqual({
        status: 'error',
        error: 'boom',
      });
    });

    it('uses one cloned session per call and destroys the base on dispose', async () => {
      stubScrub();
      const clones: any[] = [];
      const base: any = promptSession({
        clone: vi.fn(async () => {
          const clone = promptSession();
          clones.push(clone);
          return clone;
        }),
      });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => base),
      };
      (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
      const adapter = await loadAdapter();

      await adapter.summarize('一つ目');
      await adapter.summarize('二つ目');

      const createOptions = (globalThis as any).LanguageModel.create.mock.calls[0][0];
      expect((globalThis as any).LanguageModel.create).toHaveBeenCalledTimes(1);
      expect(createOptions.initialPrompts[0].role).toBe('system');
      expect(createOptions.initialPrompts[0].content).toContain('信頼できないデータ');
      expect(clones).toHaveLength(2);
      clones.forEach((clone) => expect(clone.destroy).toHaveBeenCalledTimes(1));
      expect(base.destroy).not.toHaveBeenCalled();

      adapter.dispose();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(base.destroy).toHaveBeenCalledTimes(1);
    });

    it('trims by tokens via the new measurement API and reports truncated', async () => {
      stubScrub();
      const session = promptSession({
        contextWindow: 1000,
        contextUsage: 0,
        // 1 token per character
        measureContextUsage: vi.fn(async (text: string) => text.length),
      });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
      const adapter = await loadAdapter();

      const result = await adapter.summarize('あ'.repeat(5000));

      expect(result.truncated).toBe(true);
      const prompt: string = session.prompt.mock.calls[0][0];
      expect(prompt.length).toBeLessThan(1500);
    });

    it('falls back to the legacy measureInputUsage / inputQuota names', async () => {
      stubScrub();
      const session = promptSession({
        inputQuota: 500,
        inputUsage: 0,
        measureInputUsage: vi.fn(async (text: string) => text.length),
      });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
      const adapter = await loadAdapter();

      const result = await adapter.summarize('い'.repeat(3000));

      expect(session.measureInputUsage).toHaveBeenCalled();
      expect(result.truncated).toBe(true);
    });

    it('falls back to the character cap when no token API exists', async () => {
      stubScrub();
      const session = promptSession();
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
      const adapter = await loadAdapter();

      const long = await adapter.summarize('う'.repeat(40_000));
      const short = await adapter.summarize('短い');

      expect(long.truncated).toBe(true);
      expect(short.truncated).toBe(false);
    });

    it('streams a Summarizer result through onChunk with scrubbed text', async () => {
      stubScrub();
      const summarizer = {
        summarizeStreaming: vi.fn(() =>
          (async function* () {
            yield '予算は ';
            yield 'SECRET です';
          })()
        ),
        summarize: vi.fn(),
        destroy: vi.fn(),
      };
      (globalThis as any).Summarizer = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => summarizer),
      };
      const adapter = await loadAdapter();
      const chunks: string[] = [];

      const result = await adapter.summarize('本文', {
        onChunk: (text: string) => chunks.push(text),
      });

      expect(chunks).toEqual([
        '予算は',
        '予算は SECRET です'.replace('SECRET', '[REDACTED:SECRET]'),
      ]);
      expect(result.text).toBe('予算は [REDACTED:SECRET] です');
      expect(summarizer.summarize).not.toHaveBeenCalled();
      expect(summarizer.destroy).toHaveBeenCalledTimes(1);
    });

    it('streams the Prompt API fallback as plain text', async () => {
      stubScrub();
      const session = promptSession({
        promptStreaming: vi.fn(() =>
          (async function* () {
            yield 'ストリーム';
          })()
        ),
      });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
      const adapter = await loadAdapter();
      const onChunk = vi.fn();

      const result = await adapter.summarize('本文', { onChunk });

      expect(onChunk).toHaveBeenCalledWith('ストリーム');
      expect(result.text).toBe('ストリーム');
      expect(session.prompt).not.toHaveBeenCalled();
      expect(session.promptStreaming.mock.calls[0][1].responseConstraint).toBeUndefined();
    });

    it('propagates the AbortSignal to prompt (not the shared base create), and rejects when already aborted', async () => {
      stubScrub();
      const session = promptSession();
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
      const adapter = await loadAdapter();
      const controller = new AbortController();

      await adapter.summarize('本文', { signal: controller.signal });

      // The base session is shared: aborting one caller must not destroy it.
      expect((globalThis as any).LanguageModel.create.mock.calls[0][0].signal).toBeUndefined();
      expect(session.prompt.mock.calls[0][1].signal).toBe(controller.signal);

      controller.abort();
      await expect(adapter.summarize('本文', { signal: controller.signal })).rejects.toBeDefined();
    });

    it('detects language and falls back to und below the confidence threshold', async () => {
      stubScrub();
      const detect = vi
        .fn()
        .mockResolvedValueOnce([{ detectedLanguage: 'fr', confidence: 0.9 }])
        .mockResolvedValueOnce([{ detectedLanguage: 'fr', confidence: 0.3 }]);
      const detector = { detect, destroy: vi.fn() };
      (globalThis as any).LanguageDetector = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => detector),
      };
      const adapter = await loadAdapter();

      expect(await adapter.detectLanguage('Bonjour tout le monde')).toEqual({
        provider: 'chrome-language-detector',
        language: 'fr',
        confidence: 0.9,
      });
      expect((await adapter.detectLanguage('???')).language).toBe('und');
      expect(detector.destroy).toHaveBeenCalledTimes(2);
    });

    it('passes same-language text through the translator unchanged', async () => {
      stubScrub();
      const create = vi.fn();
      (globalThis as any).Translator = {
        availability: vi.fn(async () => 'available'),
        create,
      };
      const adapter = await loadAdapter();

      const result = await adapter.translate('こんにちは SECRET', {
        sourceLanguage: 'ja',
        targetLanguage: 'ja',
      });

      expect(result.translated).toBe(false);
      expect(result.text).toBe('こんにちは [REDACTED:SECRET]');
      expect(create).not.toHaveBeenCalled();
    });

    it('translates, scrubbing the input and the output', async () => {
      stubScrub();
      const translator = {
        translate: vi.fn(async () => '予算は SECRET'),
        destroy: vi.fn(),
      };
      (globalThis as any).Translator = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => translator),
      };
      const adapter = await loadAdapter();

      const result = await adapter.translate('budget SECRET', {
        sourceLanguage: 'en',
        targetLanguage: 'ja',
      });

      expect(translator.translate.mock.calls[0][0]).toBe('budget [REDACTED:SECRET]');
      expect(result.translated).toBe(true);
      expect(result.text).toBe('予算は [REDACTED:SECRET]');
      expect(result.executable).toBe(false);
    });

    it('translates non-ja/en summaries to Japanese first and passes through otherwise', async () => {
      stubScrub();
      const detector = {
        detect: vi.fn(async () => [{ detectedLanguage: 'fr', confidence: 0.95 }]),
        destroy: vi.fn(),
      };
      const translator = { translate: vi.fn(async () => '翻訳済み本文'), destroy: vi.fn() };
      (globalThis as any).LanguageDetector = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => detector),
      };
      (globalThis as any).Translator = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => translator),
      };
      const session = promptSession();
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      (globalThis as any).Summarizer = { availability: vi.fn(async () => 'unavailable') };
      const adapter = await loadAdapter();

      const result = await adapter.summarize('Bonjour le monde');

      expect(result.translated_from).toBe('fr');
      expect(session.prompt.mock.calls[0][0]).toContain('翻訳済み本文');

      detector.detect.mockResolvedValue([{ detectedLanguage: 'en', confidence: 0.99 }]);
      const passthrough = await adapter.summarize('Hello world');
      expect(passthrough.translated_from).toBeUndefined();
    });

    it('constrains classify output to the supplied label enum', async () => {
      stubScrub();
      const session = promptSession({
        prompt: vi.fn(async () =>
          JSON.stringify({ label: 'invoice', confidence: 1.7, reason: '請求 SECRET' })
        ),
      });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      const adapter = await loadAdapter();

      const result = await adapter.runLocalTask({
        task: 'classify',
        input: '請求書 SECRET',
        options: { labels: ['invoice', 'receipt'] },
      });

      const schema = session.prompt.mock.calls[0][1].responseConstraint;
      expect(schema.properties.label.enum).toEqual(['invoice', 'receipt']);
      expect(session.prompt.mock.calls[0][0]).not.toContain('SECRET 請求');
      expect(session.prompt.mock.calls[0][0]).toContain('[REDACTED:SECRET]');
      expect(result).toMatchObject({
        provider: 'chrome-prompt',
        task: 'classify',
        executable: false,
        truncated: false,
      });
      expect(result.output).toEqual({
        label: 'invoice',
        confidence: 1,
        reason: '請求 [REDACTED:SECRET]',
      });
    });

    it('nulls a classify label that is outside the enum', async () => {
      stubScrub();
      const session = promptSession({
        prompt: vi.fn(async () => JSON.stringify({ label: 'other', confidence: 0.4, reason: 'x' })),
      });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      const adapter = await loadAdapter();

      const result = await adapter.runLocalTask({
        task: 'classify',
        input: 'text',
        options: { labels: ['a', 'b'] },
      });

      expect(result.output.label).toBeNull();
    });

    it('extracts with a caller schema and scrubs the parsed object', async () => {
      stubScrub();
      const session = promptSession({
        prompt: vi.fn(async () => JSON.stringify({ name: '山田 SECRET', tags: ['a SECRET'] })),
      });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      const adapter = await loadAdapter();
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      };

      const result = await adapter.runLocalTask({
        task: 'extract',
        input: '山田さん',
        options: { schema },
      });

      expect(session.prompt.mock.calls[0][1].responseConstraint).toBe(schema);
      expect(result.output).toEqual({
        name: '山田 [REDACTED:SECRET]',
        tags: ['a [REDACTED:SECRET]'],
      });
      expect(result.executable).toBe(false);
    });

    it('rejects invalid extract schemas before any model call', async () => {
      stubScrub();
      const create = vi.fn();
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create,
      };
      const adapter = await loadAdapter();
      const tooMany = {
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, {}])),
      };
      const withRef = {
        type: 'object',
        properties: { a: { $ref: '#/$defs/x' } },
      };

      for (const schema of [undefined, 'string', ['a'], { type: 'array' }, tooMany, withRef]) {
        await expect(
          adapter.runLocalTask({ task: 'extract', input: 'text', options: { schema } })
        ).rejects.toThrow('extract');
      }
      expect(create).not.toHaveBeenCalled();
    });

    it('rejects an extract result that misses required keys', async () => {
      stubScrub();
      const session = promptSession({ prompt: vi.fn(async () => JSON.stringify({ other: 1 })) });
      (globalThis as any).LanguageModel = {
        availability: vi.fn(async () => 'available'),
        create: vi.fn(async () => session),
      };
      const adapter = await loadAdapter();

      await expect(
        adapter.runLocalTask({
          task: 'extract',
          input: 'text',
          options: { schema: { type: 'object', properties: { a: {} }, required: ['a'] } },
        })
      ).rejects.toThrow('必須項目');
    });

    it('rejects unknown tasks and reports a clear error when experimental APIs are absent', async () => {
      stubScrub();
      const adapter = await loadAdapter();

      await expect(adapter.runLocalTask({ task: 'click', input: 'x' })).rejects.toThrow('未対応');
      await expect(adapter.proofread('text')).rejects.toThrow('Proofreader API');
      await expect(adapter.rewrite('text')).rejects.toThrow('Rewriter API');
      await expect(adapter.write('task')).rejects.toThrow('Writer API');
      await expect(adapter.detectLanguage('text')).rejects.toThrow('LanguageDetector API');
      await expect(adapter.runLocalTask({ task: 'proofread', input: 'x' })).rejects.toThrow(
        '実験的機能'
      );
    });

    it('proofreads, rewrites and writes through the experimental APIs with scrubbing both ways', async () => {
      stubScrub();
      const proofreader = {
        proofread: vi.fn(async () => ({
          correctedInput: '直した SECRET',
          corrections: [
            { startIndex: 0, endIndex: 2, type: 'spelling', explanation: '誤字 SECRET' },
          ],
        })),
        destroy: vi.fn(),
      };
      const rewriter = { rewrite: vi.fn(async () => '丁寧 SECRET'), destroy: vi.fn() };
      const writer = { write: vi.fn(async () => '下書き SECRET'), destroy: vi.fn() };
      (globalThis as any).Proofreader = { create: vi.fn(async () => proofreader) };
      (globalThis as any).Rewriter = { create: vi.fn(async () => rewriter) };
      (globalThis as any).Writer = { create: vi.fn(async () => writer) };
      const adapter = await loadAdapter();

      const proofread = await adapter.proofread('なおす SECRET');
      expect(proofreader.proofread.mock.calls[0][0]).toBe('なおす [REDACTED:SECRET]');
      expect(proofread.text).toBe('直した [REDACTED:SECRET]');
      expect(proofread.corrections[0].explanation).toBe('誤字 [REDACTED:SECRET]');
      expect(proofread.executable).toBe(false);

      const rewritten = await adapter.rewrite('ふつう SECRET', {
        tone: 'more-formal',
        length: 'bogus',
      });
      expect((globalThis as any).Rewriter.create.mock.calls[0][0]).toMatchObject({
        tone: 'more-formal',
      });
      expect((globalThis as any).Rewriter.create.mock.calls[0][0].length).toBeUndefined();
      expect(rewritten.text).toBe('丁寧 [REDACTED:SECRET]');

      const written = await adapter.runLocalTask({
        task: 'write',
        input: '依頼 SECRET',
        options: { context: '背景 SECRET' },
      });
      expect(writer.write.mock.calls[0][0]).toBe('依頼 [REDACTED:SECRET]');
      expect(writer.write.mock.calls[0][1].context).toBe('背景 [REDACTED:SECRET]');
      expect(written.output).toBe('下書き [REDACTED:SECRET]');
      expect(written.executable).toBe(false);
      [proofreader, rewriter, writer].forEach((api) => expect(api.destroy).toHaveBeenCalled());
    });

    it('describes a caller-supplied image only when image input is available', async () => {
      stubScrub();
      const session = promptSession({ prompt: vi.fn(async () => '画面に SECRET が見える') });
      const availability = vi.fn(async (opts: any) =>
        opts?.expectedInputs?.some((entry: any) => entry.type === 'image')
          ? 'available'
          : 'available'
      );
      (globalThis as any).LanguageModel = { availability, create: vi.fn(async () => session) };
      const adapter = await loadAdapter();
      const blob = { size: 1 };

      const result = await adapter.describeImage({ blob, question: '何が見える? SECRET' });

      const createOptions = (globalThis as any).LanguageModel.create.mock.calls[0][0];
      expect(createOptions.expectedInputs).toContainEqual({ type: 'image' });
      const message = session.prompt.mock.calls[0][0][0];
      expect(message.content[0].value).toContain('[REDACTED:SECRET]');
      expect(message.content[1]).toEqual({ type: 'image', value: blob });
      expect(result.text).toBe('画面に [REDACTED:SECRET] が見える');
      expect(result.executable).toBe(false);
      expect(session.destroy).toHaveBeenCalledTimes(1);

      (globalThis as any).LanguageModel.availability = vi.fn(async () => 'downloadable');
      await expect(adapter.describeImage({ blob })).rejects.toThrow('画像入力');
      await expect(adapter.describeImage({})).rejects.toThrow('画像');
    });
  });
});

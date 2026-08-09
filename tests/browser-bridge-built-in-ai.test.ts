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
});

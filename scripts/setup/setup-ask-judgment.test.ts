import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ready: vi.fn(), assist: vi.fn() }));
vi.mock('@agent/core/reasoning/judgment-provider-bootstrap', () => ({
  judgmentAssistReady: mocks.ready,
}));
vi.mock('@agent/core/reasoning/judgment-assist', async (load) => ({
  ...(await load<typeof import('@agent/core/reasoning/judgment-assist')>()),
  assistWithJudgment: mocks.assist,
}));
import { resolveSetupAskGuidanceWithJudgment } from './setup-ask-judgment.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ready.mockReturnValue(true);
});

describe('ask lifecycle guidance and bounded judgment', () => {
  it.each([
    ['Kyberion 本体と話すには？', 'conversation'],
    ['チームのチャットで話すには？', 'channel'],
    ['別のエージェントや Kyberion と連携するには？', 'coordination'],
  ])('resolves a named choice without judgment (%s)', async (text, domain) => {
    expect((await resolveSetupAskGuidanceWithJudgment(text))?.routes[0]?.id).toBe(domain);
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.assist).not.toHaveBeenCalled();
  });

  it('keeps all choices without a hint or configured calibration', async () => {
    const noHint = await resolveSetupAskGuidanceWithJudgment('Kyberion を通して会話するには？');
    expect(mocks.ready).not.toHaveBeenCalled();
    mocks.ready.mockReturnValue(false);
    const withHint = await resolveSetupAskGuidanceWithJudgment(
      'Kyberion を通してチーム内で会話するには？'
    );
    expect(withHint).toEqual(noHint);
    expect(withHint?.clarification?.choices).toHaveLength(3);
    expect(mocks.assist).not.toHaveBeenCalled();
  });

  it.each(['channel', 'unclear', 'invalid'])(
    'annotates only a valid recommendation (%s)',
    async (answer) => {
      mocks.assist.mockImplementation(async (input) => {
        const value = input.accept([{ id: input.questions[0].id, value: answer }]);
        return { value: value ?? input.baseline };
      });
      const result = await resolveSetupAskGuidanceWithJudgment(
        'Kyberion を通して仮の顧客名とチーム内で会話するには？'
      );
      expect(result?.clarification?.choices).toHaveLength(3);
      expect(result?.verification).toBe('not_run');
      expect(result?.recommended?.domain).toBe(answer === 'channel' ? answer : undefined);
      expect(mocks.assist).toHaveBeenCalledWith(
        expect.objectContaining({
          state: '{"destination_hints":["team-chat"]}',
          tier: 'personal',
          timeoutMs: 250,
          requireCalibrated: true,
        })
      );
    }
  );

  it('explains why no recommendation was available and gives the first check', async () => {
    mocks.ready.mockReturnValue(false);
    const text = 'Kyberion を通してチーム内で会話するには？';
    expect((await resolveSetupAskGuidanceWithJudgment(text))?.explanation).toBeUndefined();
    expect((await resolveSetupAskGuidanceWithJudgment(text, true))?.explanation).toMatchObject({
      decision: 'assist_not_ready',
      domain: 'conversation',
      first_check: 'pnpm surfaces status',
    });
  });

  it('leaves actions to the ordinary ask path', async () => {
    expect(
      await resolveSetupAskGuidanceWithJudgment('別の Kyberion にメッセージを送ってください。')
    ).toBeUndefined();
    expect(mocks.ready).not.toHaveBeenCalled();
  });
});

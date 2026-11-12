import { describe, expect, it, vi } from 'vitest';

vi.mock('./plan-preview-response', () => ({
  parsePlanPreviewResponse: (value: { preview?: unknown } | null) =>
    value?.preview ? { preview: value.preview } : undefined,
}));

import { PlanFlowError, approvePlanAndStart, requestPlanPreview } from './mission-planning';
import { planErrorKey } from '../../components/mission-plan/MissionPlanPanel';

const draft = {
  requestText: 'Draft the weekly report',
  missionType: 'proposal-brief',
  orgRole: 'operator',
  tier: 'confidential' as const,
};
const preview = { missionId: 'MSN-PLAN-1' } as never;

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('mission planning flow', () => {
  it('previews through POST /api/ops/plan-preview with the draft and locale', async () => {
    const fetchImpl = vi.fn(() => reply(200, { preview }));
    await expect(requestPlanPreview(draft, 'ja', fetchImpl)).resolves.toEqual(preview);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ops/plan-preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ...draft, locale: 'ja' });
  });

  it('refuses an empty request without calling the server', async () => {
    const fetchImpl = vi.fn();
    await expect(
      requestPlanPreview({ ...draft, requestText: '  ' }, 'ja', fetchImpl)
    ).rejects.toMatchObject({ code: 'request_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never starts without a current preview (stale-preview guard)', async () => {
    const fetchImpl = vi.fn();
    const base = { sessionId: null, requestText: draft.requestText, locale: 'ja' };
    await expect(
      approvePlanAndStart({ ...base, preview: null, stale: true }, fetchImpl)
    ).rejects.toMatchObject({ code: 'preview_required' });
    await expect(
      approvePlanAndStart({ ...base, preview, stale: true }, fetchImpl)
    ).rejects.toMatchObject({ code: 'preview_stale' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('proposes then approves under one session, exactly once each', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => reply(200, { status: 'ok', response: 'proposed' }))
      .mockImplementationOnce(() =>
        reply(200, { status: 'ok', response: 'started', mission: { missionId: 'MSN-PLAN-1' } })
      );
    await expect(
      approvePlanAndStart(
        { preview, stale: false, sessionId: null, requestText: draft.requestText, locale: 'ja' },
        fetchImpl
      )
    ).resolves.toEqual({ missionId: 'MSN-PLAN-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(bodies[0]).toMatchObject({ query: draft.requestText, sessionId: 'MSN-PLAN-1' });
    expect(bodies[1]).toMatchObject({ action: 'approve_mission', sessionId: 'MSN-PLAN-1' });
  });

  it('stops after a refused proposal and maps failures to operator sentences', async () => {
    const fetchImpl = vi.fn(() => reply(403, { error: 'denied' }));
    const failure = await approvePlanAndStart(
      { preview, stale: false, sessionId: 'S', requestText: 'x', locale: 'ja' },
      fetchImpl
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanFlowError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(planErrorKey(failure)).toBe('ia_shell_plan_start_failed');
    expect(planErrorKey(new PlanFlowError('preview_stale'))).toBe('ia_shell_plan_preview_stale');
    expect(planErrorKey(new Error('boom'))).toBe('ia_shell_plan_failed');
  });
});

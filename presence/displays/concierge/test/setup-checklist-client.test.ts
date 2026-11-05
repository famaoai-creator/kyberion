import { describe, expect, it } from 'vitest';
import { buildSetupChecklist } from '@agent/core/surface/setup-checklist-model';
import {
  SETUP_CHECKLIST_PATH,
  parseSetupChecklistResponse,
} from '../src/lib/setup-checklist-client';
import { isFrontDeskMemberApiPath } from '../src/lib/front-desk-fetch';

const served = buildSetupChecklist({
  visibleTenants: 1,
  reasoningMode: 'claude-cli',
  charterInForce: false,
  notificationChannel: null,
  projects: 0,
  missions: 3,
  budget: { posture: 'warn', daily_cap_usd: 50, mission_cap_usd: 20, uses_default: true },
});

describe('setup checklist client', () => {
  it('reads the surface operation through the member transport', () => {
    expect(SETUP_CHECKLIST_PATH).toBe('/api/v1/setup/checklist');
    expect(isFrontDeskMemberApiPath(SETUP_CHECKLIST_PATH)).toBe(true);
  });

  it('accepts the served checklist and recomputes progress from the steps', () => {
    const parsed = parseSetupChecklistResponse({ ok: true, operation: 'x', data: served });
    expect(parsed).toMatchObject({ done: 4, total: 7, complete: false, next: 'autonomy' });
    expect(parsed?.steps.map((step) => step.status)).toEqual([
      'done',
      'done',
      'todo',
      'unknown',
      'todo',
      'done',
      'done',
    ]);
    expect(parsed?.budget?.daily_cap_usd).toBe(50);
  });

  it('rejects malformed payloads instead of showing a wrong state', () => {
    expect(parseSetupChecklistResponse(null)).toBeUndefined();
    expect(parseSetupChecklistResponse({ ok: false })).toBeUndefined();
    const bad = { ...served, steps: [{ ...served.steps[0], anchor: 'javascript:alert(1)' }] };
    expect(parseSetupChecklistResponse({ ok: true, data: bad })).toBeUndefined();
    const unknown = { ...served, steps: [{ ...served.steps[0], id: 'other' }] };
    expect(parseSetupChecklistResponse({ ok: true, data: unknown })).toBeUndefined();
  });

  it('drops a malformed budget but keeps the steps', () => {
    const parsed = parseSetupChecklistResponse({
      ok: true,
      data: { ...served, budget: { daily_cap_usd: 'lots' } },
    });
    expect(parsed?.steps).toHaveLength(7);
    expect(parsed?.budget).toBeUndefined();
  });
});

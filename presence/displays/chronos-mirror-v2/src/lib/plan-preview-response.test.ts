import { describe, expect, it } from 'vitest';
import { parsePlanPreviewResponse } from './plan-preview-response';

const preview = {
  missionId: 'PREVIEW-1234',
  requestText: 'Ship the report',
  source: 'fallback',
  confidence: 0.8,
  goal: { summary: 'Ship report', successCondition: 'Report is delivered' },
  delivery: {
    mode: 'one_shot',
    requiresApproval: true,
    clarificationNeeded: false,
    askHumanToConfirm: true,
    rationale: 'Human approval is required',
  },
  execution: {
    shape: 'mission',
    taskType: 'delivery',
    requiredInputs: ['report'],
    missingInputs: [],
    clarificationQuestions: [],
    recommendedNextStep: 'Approve the mission',
  },
  workflow: [
    {
      id: 'draft',
      label: 'Draft',
      description: 'Draft the report',
      actuator: 'writer',
      phase: 'execute',
    },
  ],
  team: {
    assignments: [{ team_role: 'owner', status: 'assigned', agent_id: 'agent-1' }],
    team_governance: { composition: { required_roles: ['owner'] } },
  },
};

describe('parsePlanPreviewResponse', () => {
  it('accepts the display contract and returns the preview', () => {
    expect(parsePlanPreviewResponse({ preview })).toEqual({ preview });
  });

  it.each([
    ['missing preview', {}],
    ['invalid confidence', { preview: { ...preview, confidence: 2 } }],
    [
      'invalid workflow',
      { preview: { ...preview, workflow: [{ ...preview.workflow[0], id: '' }] } },
    ],
    [
      'invalid assignment',
      {
        preview: {
          ...preview,
          team: { ...preview.team, assignments: [{ team_role: 'owner', status: 'assigned' }] },
        },
      },
    ],
    [
      'dangerous nested key',
      {
        preview: {
          ...preview,
          team: { ...preview.team, ['__proto__']: { polluted: true } },
        },
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parsePlanPreviewResponse(value)).toBeUndefined();
  });
});

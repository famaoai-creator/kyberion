import { describe, expect, it } from 'vitest';
import {
  parseMissionApprovalResponse,
  parseMissionProposalResponse,
} from './agent-mutation-response';

describe('mission mutation response parsers', () => {
  it('accepts proposal and approval success responses', () => {
    expect(parseMissionProposalResponse({ status: 'ok', response: 'Ready for approval' })).toEqual({
      status: 'ok',
      response: 'Ready for approval',
    });
    expect(
      parseMissionApprovalResponse({
        status: 'ok',
        response: 'Mission started',
        mission: { missionId: 'MSN-1', tier: 'confidential' },
      })
    ).toEqual({
      status: 'ok',
      response: 'Mission started',
      mission: { missionId: 'MSN-1' },
    });
  });

  it.each([
    ['proposal status', parseMissionProposalResponse, { status: 'error', response: 'no' }],
    ['proposal response', parseMissionProposalResponse, { status: 'ok', response: [] }],
    ['approval mission', parseMissionApprovalResponse, { status: 'ok', response: 'started' }],
    [
      'approval mission id',
      parseMissionApprovalResponse,
      { status: 'ok', response: 'started', mission: { missionId: '' } },
    ],
    [
      'dangerous key',
      parseMissionApprovalResponse,
      {
        status: 'ok',
        response: 'started',
        mission: { missionId: 'MSN-1', ['__proto__']: { polluted: true } },
      },
    ],
  ])('rejects %s', (_label, parser, value) => {
    expect(parser(value)).toBeUndefined();
  });
});

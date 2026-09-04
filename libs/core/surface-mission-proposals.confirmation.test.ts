import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  buildMissionProposalConfirmationText,
  isSlackMissionConfirmation,
  isSlackMissionRejection,
  loadMissionProposalStateAtPath,
} from './surface-mission-proposals.js';
import { t } from './t.js';

const testRoot = pathResolver.sharedTmp('surface-mission-proposal-state-test');

afterEach(() => safeRmSync(testRoot, { recursive: true, force: true }));

// UX-04 acceptance 2: numbered-choice confirmation (1=create / 2=decline)
// with generous yes/はい acceptance and an explicit decline path.
describe('mission proposal confirmation grammar (UX-04)', () => {
  it('uses the shared catalog for the confirmation prompt and contract labels', () => {
    const text = buildMissionProposalConfirmationText({
      summary: 'Create the reviewed mission',
      intentResolution: {
        request_id: 'ir_proposal_confirmation',
        normalized_intent: 'create_mission',
        missing_inputs: [],
        resolution_shape: 'mission',
        outcome_kind: 'service_change',
        authority_level: 'approval_required',
        next_action: {
          kind: 'request_approval',
          label: 'Approve the mission.',
          consequence: 'The mission remains pending until approval.',
        },
        rationale: 'approval is required',
      },
    });
    expect(text).toContain(t('bridge:mission_proposal_confirmation_choices', undefined, 'ja'));
    expect(text).toContain(`${t('bridge:contract_authority', undefined, 'ja')}:`);
    expect(text).toContain(`${t('bridge:contract_next_action', undefined, 'ja')}:`);
    expect(text).toContain(`${t('bridge:contract_outcome', undefined, 'ja')}:`);
  });

  it('accepts the numbered choice and the classic affirmations', () => {
    for (const text of ['1', '1)', '1.', '作成する', '実行する', 'はい', 'yes', 'お願いします']) {
      expect(isSlackMissionConfirmation(text), `should accept: ${text}`).toBe(true);
    }
  });

  it('recognizes explicit declines', () => {
    for (const text of [
      '2',
      '2)',
      'やめる',
      'やめて',
      'キャンセル',
      '中止',
      'no',
      'cancel',
      'stop',
    ]) {
      expect(isSlackMissionRejection(text), `should decline: ${text}`).toBe(true);
    }
  });

  it('keeps ordinary utterances out of both buckets', () => {
    for (const text of ['来週の予定を教えて', 'what is 1+1', 'ステータスは?']) {
      expect(isSlackMissionConfirmation(text)).toBe(false);
      expect(isSlackMissionRejection(text)).toBe(false);
    }
  });

  it('never classifies the same text as both confirm and decline', () => {
    for (const text of ['1', '2', 'はい', 'やめる', 'yes', 'no']) {
      expect(isSlackMissionConfirmation(text) && isSlackMissionRejection(text)).toBe(false);
    }
  });
});

describe('mission proposal state boundary', () => {
  it('validates the state and binds it to the ingress identity', () => {
    const filePath = path.join(testRoot, 'proposal.json');
    safeMkdir(testRoot, { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({
        surface: 'slack',
        channel: 'C123',
        threadTs: '1710000000.000500',
        proposal: { intent: 'create_mission', mission_type: 'product_development' },
        createdAt: '2026-09-03T00:00:00.000Z',
      })
    );

    expect(
      loadMissionProposalStateAtPath(filePath, {
        surface: 'slack',
        channel: 'C123',
        threadTs: '1710000000.000500',
      }).proposal.intent
    ).toBe('create_mission');
    expect(() =>
      loadMissionProposalStateAtPath(filePath, {
        surface: 'slack',
        channel: 'C999',
        threadTs: '1710000000.000500',
      })
    ).toThrow('[SURFACE_MISSION_PROPOSAL_SCOPE_MISMATCH]');

    safeWriteFile(
      filePath,
      JSON.stringify({
        surface: 'slack',
        channel: 'C123',
        threadTs: '1710000000.000500',
        proposal: { intent: 'create_mission' },
        createdAt: '2026-09-03T00:00:00.000Z',
        unexpected: true,
      })
    );
    expect(() => loadMissionProposalStateAtPath(filePath)).toThrow(
      /Invalid catalog surface-mission-proposal-state/
    );

    safeWriteFile(
      filePath,
      JSON.stringify({
        channel: 'C123',
        threadTs: '1710000000.000500',
        proposal: { intent: 'create_mission' },
        createdAt: '2026-09-03T00:00:00.000Z',
      })
    );
    expect(
      loadMissionProposalStateAtPath(filePath, {
        surface: 'slack',
        channel: 'C123',
        threadTs: '1710000000.000500',
      }).surface
    ).toBe('slack');

    safeRmSync(filePath, { recursive: true, force: true });
    safeMkdir(filePath, { recursive: true });
    expect(() => loadMissionProposalStateAtPath(filePath)).toThrow(
      '[SURFACE_MISSION_PROPOSAL] state must be a regular file'
    );
  });
});

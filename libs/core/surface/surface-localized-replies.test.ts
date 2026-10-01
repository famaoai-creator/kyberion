import { afterEach, describe, expect, it } from 'vitest';
import { parseExecutionFeedbackText } from '../execution-feedback.js';
import { t } from '../t.js';
import { buildKnowledgeQueryReply } from './surface-runtime-helpers.js';
import { buildExecutionFeedbackPrompt } from './surface-runtime-conversation-data.js';
import {
  SurfaceSteeringAuthorityError,
  formatSteeringRejection,
} from './surface-steering-authority.js';
import { validateSurfaceUxContract, repairSurfaceUxContractText } from './surface-ux-contract.js';
import { buildSurfaceAsyncAcceptedReply, formatSurfaceRecoveryAction } from './surface-ux.js';
import { buildSurfaceApprovalAskWhyActions } from './surface-approval-ui.js';

const ORIGINAL_LOCALE = process.env.KYBERION_LOCALE;

afterEach(() => {
  if (ORIGINAL_LOCALE === undefined) delete process.env.KYBERION_LOCALE;
  else process.env.KYBERION_LOCALE = ORIGINAL_LOCALE;
});

const KANA = /[぀-ヿ]/;

describe('surface replies follow the active locale (IT-02)', () => {
  it('renders the steering rejection in en and ja from the same catalog keys', () => {
    const error = new SurfaceSteeringAuthorityError('no_session_for_thread', {
      surface: 'slack',
      missionId: 'MSN-X',
    } as never);
    process.env.KYBERION_LOCALE = 'en';
    const en = formatSteeringRejection(error);
    expect(en).toContain('This thread is not the owner of mission MSN-X');
    expect(en).not.toMatch(KANA);
    expect(validateSurfaceUxContract({ text: en }).valid).toBe(true);

    process.env.KYBERION_LOCALE = 'ja';
    const ja = formatSteeringRejection(error);
    expect(ja).toContain('ミッション MSN-X のオーナーではありません');
    expect(validateSurfaceUxContract({ text: ja }).valid).toBe(true);
  });

  it('interpolates template variables in both locales', () => {
    expect(t('surface:steering_paused', { missionId: 'MSN-1' }, 'en')).toBe(
      'State: Paused mission MSN-1.'
    );
    expect(t('surface:steering_paused', { missionId: 'MSN-1' }, 'ja')).toBe(
      '状態: ミッション MSN-1 を一時停止しました。'
    );
  });

  it('renders the execution feedback prompt without Japanese prose in en', () => {
    process.env.KYBERION_LOCALE = 'en';
    expect(buildExecutionFeedbackPrompt('use-case-a')).toContain('to improve this scenario');
    expect(buildExecutionFeedbackPrompt('use-case-a')).toContain('feedback use-case-a: satisfied');
    expect(parseExecutionFeedbackText('feedback use-case-a: satisfied')).not.toBeNull();
    process.env.KYBERION_LOCALE = 'ja';
    expect(buildExecutionFeedbackPrompt('use-case-a')).toContain('このシナリオを改善する場合は');
  });

  it('localizes ask-why labels and the async accepted reply', () => {
    const en = buildSurfaceApprovalAskWhyActions('r1', 'en').map((a) => a.label);
    const ja = buildSurfaceApprovalAskWhyActions('r1', 'ja').map((a) => a.label);
    expect(en).toContain('Skip');
    expect(ja).toContain('スキップ');
    expect(
      buildSurfaceAsyncAcceptedReply({ requestId: 'q1', receiver: 'worker', language: 'en' })
    ).toContain('Accepted.');
    expect(
      buildSurfaceAsyncAcceptedReply({ requestId: 'q1', receiver: 'worker', language: 'ja' })
    ).toContain('依頼を受け付けました');
    expect(formatSurfaceRecoveryAction({ reason: 'r', next_step: 'x' } as never, 'en')).toBe(
      'r Next step: x'
    );
    expect(formatSurfaceRecoveryAction({ reason: 'r', next_step: 'x' } as never, 'ja')).toBe(
      'r 次の一手: x'
    );
  });

  it('follows the query language for knowledge replies and the text language for UX repair', () => {
    expect(
      buildKnowledgeQueryReply({ queryText: 'find docs', results: [], providerLabel: 'P' })
    ).toContain("couldn't find");
    expect(
      buildKnowledgeQueryReply({ queryText: '資料を探して', results: [], providerLabel: 'P' })
    ).toContain('見つかった情報はありませんでした');
    expect(repairSurfaceUxContractText('the actuator failed')).toBe('the capability failed');
    expect(repairSurfaceUxContractText('actuator が失敗しました')).toBe('機能 が失敗しました');
  });
});

import { describe, expect, it } from 'vitest';
import { validateSurfaceUxContract } from './surface-ux-contract.js';

describe('surface-ux-contract', () => {
  it('accepts user-facing summaries with request/plan/state/result signals', () => {
    const result = validateSurfaceUxContract({
      text: [
        'Request: 今週の進捗レポートを作成する依頼を受け付けました。',
        'Plan: 進捗データを収集し、docx でレポートを生成します。',
        'State: running',
        'Result: 完了後に成果物を返却します。',
      ].join('\n'),
    });
    expect(result.valid, result.violations.join('; ')).toBe(true);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('rejects internal vocabulary leakage in default output', () => {
    const result = validateSurfaceUxContract({
      text: 'Plan: ADF と actuator を使って execution_shape を決定します。',
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((item) => item.includes('internal-only vocabulary'))).toBe(true);
  });

  it('requires consequence and action when approval is required', () => {
    const withoutGuidance = validateSurfaceUxContract({
      text: 'State: waiting for approval.',
      approval_required: true,
    });
    expect(withoutGuidance.valid).toBe(false);

    const withGuidance = validateSurfaceUxContract({
      text: [
        'State: waiting for approval.',
        '承認されない場合は処理が停止します。',
        '次のアクション: approve を実行してください。',
      ].join('\n'),
      approval_required: true,
    });
    expect(withGuidance.valid, withGuidance.violations.join('; ')).toBe(true);
  });
});

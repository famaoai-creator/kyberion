import { describe, expect, it } from 'vitest';
import { repairSurfaceUxContractText, validateSurfaceUxContract } from './surface-ux-contract.js';

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

  it('accepts plain-language task and mission guidance for operators', () => {
    const taskResult = validateSurfaceUxContract({
      text: [
        '短い作業として進めます。',
        'Plan: 予定を確認して、必要な情報だけ集めます。',
        'Result: 次の確認点を返します。',
      ].join('\n'),
    });
    expect(taskResult.valid, taskResult.violations.join('; ')).toBe(true);
    expect(taskResult.signals).toContain('bounded_task');

    const missionResult = validateSurfaceUxContract({
      text: [
        '承認と記録が必要なためミッションとして進めます。',
        'Plan: 関係者調整と証跡をそろえます。',
        'Next Action: 承認が必要です。',
      ].join('\n'),
    });
    expect(missionResult.valid, missionResult.violations.join('; ')).toBe(true);
    expect(missionResult.signals).toContain('governed_mission');
  });

  it('accepts review guidance that states purpose, role, and tenant context', () => {
    const result = validateSurfaceUxContract({
      text: [
        'Review対象: この文章です。',
        'レビュー目的: 承認前確認です。',
        '役割: 法務レビュー担当。',
        'テナント: sales。',
        'Plan: source kind を確認してからレビューします。',
      ].join('\n'),
    });

    expect(result.valid, result.violations.join('; ')).toBe(true);
    expect(result.signals).toContain('review_context');
  });

  it('rejects internal vocabulary leakage in default output', () => {
    const result = validateSurfaceUxContract({
      text: 'Plan: ADF と actuator を使って mission_class と workflow_id と execution_shape を決定します。',
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((item) => item.includes('internal-only vocabulary'))).toBe(true);
  });

  it('repairs internal vocabulary leakage before delivery when it can be localized safely', () => {
    const repaired = repairSurfaceUxContractText(
      'Plan: ADF と actuator を使って mission_class と workflow_id と execution_shape を決定します。Result: 完了後に返します。'
    );
    expect(repaired).not.toContain('ADF');
    expect(repaired).not.toContain('actuator');
    expect(repaired).not.toContain('mission_class');
    expect(validateSurfaceUxContract({ text: repaired }).valid).toBe(true);
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

// WI-08: pure parsing/building helpers + the deterministic (no model call)
// `work_inventory_table` canvas for the `work_inventory` hearing scenario.
import { describe, expect, it } from 'vitest';
import { findHearingScenario } from '@agent/core/hearing-scenario-catalog';
import {
  applyHearingTurn,
  createHearingRecord,
  type HearingRecord,
  type HearingScenario,
} from './hearing.js';
import {
  buildWorkInventoryDecompositionInput,
  inferWorkInventoryTriggerKind,
  parseWorkInventoryEffortMinutes,
  parseWorkInventoryFrequency,
  renderWorkInventoryCanvasHtml,
  splitWorkInventorySystems,
  workInventoryRequirementAnswer,
} from './hearing-work-inventory.js';

function workInventoryScenario(): HearingScenario {
  const entry = findHearingScenario('work_inventory');
  if (!entry) throw new Error('hearing-scenarios.json is missing its work_inventory entry');
  return {
    id: entry.id,
    requirements: entry.requirements.map(({ id, label_key }) => ({ id, label_key })),
  };
}

function recordWithAnswers(answers: Record<string, string>): HearingRecord {
  const scenario = workInventoryScenario();
  let record = createHearingRecord('sess-wi-1', '2026-09-22T00:00:00.000Z', scenario);
  for (const [id, text] of Object.entries(answers)) {
    record = applyHearingTurn(
      record,
      { text, request_id: `turn-${id}` },
      '2026-09-22T00:01:00.000Z',
      scenario
    );
  }
  return record;
}

describe('inferWorkInventoryTriggerKind', () => {
  it('detects schedule from 毎週/毎日/毎月/daily/weekly/monthly', () => {
    expect(inferWorkInventoryTriggerKind('毎週月曜に実施', '')).toBe('schedule');
    expect(inferWorkInventoryTriggerKind('', 'weekly on Monday')).toBe('schedule');
  });

  it('detects event from メール/受信/届いたら', () => {
    expect(inferWorkInventoryTriggerKind('依頼メールが届いたら', '')).toBe('event');
  });

  it('falls back to request', () => {
    expect(inferWorkInventoryTriggerKind('上長からの口頭依頼', '')).toBe('request');
  });
});

describe('parseWorkInventoryFrequency', () => {
  it('parses 毎日/毎週/毎月・月次/四半期 to their WorkFrequencyPer', () => {
    expect(parseWorkInventoryFrequency('毎日確認')).toEqual({ per: 'day', count: 1 });
    expect(parseWorkInventoryFrequency('毎週提出')).toEqual({ per: 'week', count: 1 });
    expect(parseWorkInventoryFrequency('毎月月末')).toEqual({ per: 'month', count: 1 });
    expect(parseWorkInventoryFrequency('月次で集計')).toEqual({ per: 'month', count: 1 });
    expect(parseWorkInventoryFrequency('四半期ごとに報告')).toEqual({ per: 'quarter', count: 1 });
  });

  it('parses "週3" style counts', () => {
    expect(parseWorkInventoryFrequency('週3で対応')).toEqual({ per: 'week', count: 3 });
  });

  it('returns undefined when nothing obvious matches', () => {
    expect(parseWorkInventoryFrequency('不定期')).toBeUndefined();
  });
});

describe('parseWorkInventoryEffortMinutes', () => {
  it('parses "30分" as 30 minutes', () => {
    expect(parseWorkInventoryEffortMinutes('30分くらい')).toBe(30);
  });

  it('parses "1時間" as 60 minutes', () => {
    expect(parseWorkInventoryEffortMinutes('1時間ほど')).toBe(60);
  });

  it('parses "1.5h" as 90 minutes', () => {
    expect(parseWorkInventoryEffortMinutes('about 1.5h')).toBe(90);
  });

  it('returns undefined when nothing obvious matches', () => {
    expect(parseWorkInventoryEffortMinutes('すぐ終わる')).toBeUndefined();
  });
});

describe('splitWorkInventorySystems', () => {
  it('splits on 、, and /', () => {
    expect(splitWorkInventorySystems('Slack、メール, Excel/Notion')).toEqual([
      'Slack',
      'メール',
      'Excel',
      'Notion',
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(splitWorkInventorySystems('  ')).toEqual([]);
  });
});

describe('buildWorkInventoryDecompositionInput', () => {
  it('maps every requirement answer onto the proposeWorkDecomposition input shape', () => {
    const record = recordWithAnswers({
      task_name: '月次請求書の作成',
      trigger: '毎月末に経理から依頼',
      frequency: '毎月',
      effort: '1時間',
      steps: '請求データを集計する→請求書を作成する→PDF化して送付する',
      systems: 'Excel、Slack',
      decisions: '金額が10万円を超える場合は上長の承認が必要',
      output: 'PDF 請求書を経理チームに渡す',
    });
    const input = buildWorkInventoryDecompositionInput(record, { scope: { tenant_slug: 'acme' } });
    expect(input.title).toBe('月次請求書の作成');
    expect(input.description).toContain('請求データを集計する');
    expect(input.description).toContain('金額が10万円を超える場合は上長の承認が必要');
    expect(input.systems).toEqual(['Excel', 'Slack']);
    expect(input.trigger).toEqual({ kind: 'schedule', description: '毎月末に経理から依頼' });
    expect(input.frequency).toEqual({ per: 'month', count: 1 });
    expect(input.effort_minutes_per_run).toBe(60);
    expect(input.scope).toEqual({ tenant_slug: 'acme' });
  });

  it('omits frequency/effort/systems when nothing was parseable', () => {
    const record = recordWithAnswers({
      task_name: 'ad hoc thing',
      trigger: 'someone asks',
      steps: 'do it',
    });
    const input = buildWorkInventoryDecompositionInput(record, { scope: {} });
    expect(input.frequency).toBeUndefined();
    expect(input.effort_minutes_per_run).toBeUndefined();
    expect(input.systems).toBeUndefined();
    expect(input.trigger).toEqual({ kind: 'request', description: 'someone asks' });
  });
});

describe('workInventoryRequirementAnswer', () => {
  it('returns the trimmed answer for a requirement id, or empty string when unanswered', () => {
    const record = recordWithAnswers({ task_name: '  月次レポート作成  ' });
    expect(workInventoryRequirementAnswer(record, 'task_name')).toBe('月次レポート作成');
    expect(workInventoryRequirementAnswer(record, 'trigger')).toBe('');
  });
});

describe('renderWorkInventoryCanvasHtml', () => {
  it('renders every requirement label/answer, is sanitized, and shows the empty-steps message before steps is answered', async () => {
    const record = recordWithAnswers({ task_name: '月次請求書の作成' });
    const html = await renderWorkInventoryCanvasHtml(record, 'en');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script');
    expect(html).toContain('月次請求書の作成');
    expect(html).not.toContain('<table><thead><tr><th>Step</th>');
  });

  it('renders the heuristic step-decomposition preview once steps is answered, without calling a model', async () => {
    const record = recordWithAnswers({
      task_name: '月次請求書の作成',
      steps: '請求データを集計する→請求書を作成する→PDF化して送付する',
    });
    const html = await renderWorkInventoryCanvasHtml(record, 'en');
    expect(html).toContain('<table>');
    expect(html).toContain('請求データを集計する');
    expect(html).not.toContain('<script');
  });
});

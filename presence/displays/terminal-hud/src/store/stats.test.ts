import { describe, expect, it } from 'vitest';
import { countUsageByKind, statsViewModel } from './stats.js';

describe('terminal HUD usage counter', () => {
  it('connects bounded and unavailable trace reads to the actual stats view', () => {
    const i18n = {
      locale: 'en' as const,
      tr: (key: string, params?: Record<string, string | number>) =>
        `${key}:${JSON.stringify(params || {})}`,
    };
    const view = statsViewModel(
      {
        components: [],
        regressions: [],
        usageByKind: [],
        traces: [],
        traceRead: { status: 'unavailable', truncated: true, omittedLines: 12, skippedLines: 2 },
      },
      i18n
    );
    const lines = view.sections!.flatMap((section) => section.lines).join('\n');
    expect(lines).toContain('tui:tui_read_unavailable');
    expect(lines).toContain('"omitted":12');
    expect(lines).toContain('"count":2');
  });

  it('counts usage-ledger records by resource_kind', () => {
    expect(
      countUsageByKind([
        { resource_kind: 'llm' },
        { resource_kind: 'llm' },
        { resource_kind: 'saas' },
        {},
      ])
    ).toEqual([
      { kind: 'llm', count: 2 },
      { kind: 'saas', count: 1 },
      { kind: 'other', count: 1 },
    ]);
  });
});

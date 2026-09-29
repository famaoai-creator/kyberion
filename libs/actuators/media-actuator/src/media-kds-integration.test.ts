/**
 * KDS v2 → media-actuator wiring. Proves the extended design foundation is not
 * dead data: a brief that names a style or composition changes what the deck
 * builder actually emits, and a brief that names neither is untouched.
 */
import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';
import {
  resolveBodyZoneKey,
  resolveZoneRegionText,
  resolveZoneRegions,
} from './media-layout-catalog.js';

function brief(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'proposal-brief',
    document_profile: 'executive-proposal',
    render_target: 'pptx',
    locale: 'ja-JP',
    title: '業務自動化の提案',
    objective: '承認までの時間を短縮する。',
    story: {
      core_message: '証跡つきで意思決定を速くする。',
      closing_cta: '本方針の承認をお願いします。',
    },
    sections: [
      {
        title: '成果',
        objective: '主要指標',
        body: [
          '承認時間 -42%',
          '完了ミッション 128',
          '手戻り率 2.1%',
          '監査証跡は自動で残ります。',
        ],
      },
      {
        title: '進め方',
        objective: '段階導入',
        body: ['第1段階: 現状可視化', '第2段階: 自動化', '第3段階: 定着'],
      },
    ],
    ...overrides,
  };
}

async function compile(input: Record<string, unknown>): Promise<any> {
  const result = await handleAction({
    action: 'pipeline',
    context: { last_json: input },
    steps: [
      {
        type: 'transform',
        op: 'brief_to_design_protocol',
        params: { from: 'last_json', export_as: 'pptx_design' },
      },
    ],
  } as any);
  expect(result.status).toBe('succeeded');
  return result.context.pptx_design;
}

const themeOf = (protocol: any) => JSON.stringify(protocol.theme ?? protocol.metadata?.theme ?? {});
const zonesOf = (protocol: any): string[] =>
  protocol.slides.map((slide: any) => slide.metadata?.bodyZone).filter(Boolean);

describe('KDS v2 in the media actuator', () => {
  it('leaves a brief without a style byte-for-byte on the baseline path', async () => {
    const a = await compile(brief());
    const b = await compile(brief());
    expect(themeOf(a)).toBe(themeOf(b));
    expect(zonesOf(a).some((zone) => zone.startsWith('kds-'))).toBe(false);
  });

  it('design_style restyles the deck theme (palette + heading face)', async () => {
    const base = await compile(brief());
    const styled = await compile(brief({ design_style: 'editorial' }));
    expect(themeOf(styled)).not.toBe(themeOf(base));
    expect(themeOf(styled)).toContain('c2410c'); // editorial accent (pptx palette has no '#')
    const fonts = new Set<string>();
    JSON.stringify(styled, (key, value) => {
      if (key === 'fontFamily') fonts.add(String(value));
      return value;
    });
    expect([...fonts].join(';')).toMatch(/Serif|Mincho/); // editorial heading face
  });

  it('design_system_id kds-<style> selects the style and its preferred compositions', async () => {
    const styled = await compile(brief({ design_system_id: 'kds-graphite-executive' }));
    expect(themeOf(styled)).toContain('1d4ed8');
    // the ROI slide is KPI-shaped, so it takes the stat-rail composition
    expect(zonesOf(styled)).toContain('kds-stat-rail');
    expect(styled.metadata.layoutDiagnostics.overflowCount).toBe(0);
  });

  it('a slide can pick its own composition; regions stay inside the body area', () => {
    expect(resolveBodyZoneKey('content', undefined, process.cwd(), 'stat-rail')).toBe(
      'kds-stat-rail'
    );
    // unknown composition ids fall back to the normal semantic zone
    expect(resolveBodyZoneKey('content', undefined, process.cwd(), 'nope')).not.toMatch(/^kds-/);
    const body = { x: 0.35, y: 1.3, w: 9.3, h: 3.6 };
    const regions = resolveZoneRegions('kds-stat-rail', undefined, body)!;
    const kpis = regions.filter((r) => r.id.startsWith('kpi-'));
    expect(kpis).toHaveLength(3);
    expect(kpis.map((r) => r.source)).toEqual(['body_line:1', 'body_line:2', 'body_line:3']);
    expect(regions.find((r) => r.id === 'body')?.source).toBe('body_rest:3');
    for (const r of regions) {
      expect(r.pos.x).toBeGreaterThanOrEqual(body.x - 0.001);
      expect(r.pos.y).toBeGreaterThanOrEqual(body.y - 0.001);
      expect(r.pos.x + r.pos.w).toBeLessThanOrEqual(body.x + body.w + 0.001);
      expect(r.pos.y + r.pos.h).toBeLessThanOrEqual(body.y + body.h + 0.001);
    }
    expect(resolveZoneRegions('kds-nope', undefined, body)).toBeUndefined();
  });

  it('never drops lines: the last tile of a body-less composition takes the rest', () => {
    const cards = resolveZoneRegions('kds-three-up', undefined, { x: 0, y: 0, w: 9, h: 3 })!;
    expect(cards.map((r) => r.source)).toEqual(['body_line:1', 'body_line:2', 'body_rest:2']);
    const side = resolveZoneRegions('kds-sidebar-detail', undefined, { x: 0, y: 0, w: 9, h: 3 })!;
    expect(side.find((r) => r.id === 'side')?.source).toBe('objective');
    expect(side.find((r) => r.id === 'body')?.source).toBe('body_all');
  });

  it('assigns one body line per KPI tile', () => {
    const lines = ['承認時間 -42%', '完了ミッション 128', '手戻り率 2.1%', '補足'];
    const ctx = {
      bodyLines: lines,
      balanced: { left: [], right: [] },
      objective: '',
      cta: '',
      title: '',
    };
    expect(resolveZoneRegionText('body_line:2', ctx)).toBe(lines[1]);
    expect(resolveZoneRegionText('body_rest:3', ctx)).toBe('補足');
  });
});

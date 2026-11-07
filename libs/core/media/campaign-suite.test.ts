import { describe, expect, it } from 'vitest';
import {
  buildCampaignPlan,
  buildLandingPageHtml,
  type CampaignBrief,
  validateCampaignManifest,
} from './campaign-suite.js';
import {
  DEFAULT_CHRONOS_WEB_THEME_PACK,
  webThemePackToCssVars,
} from '../design/web-design-system.js';

function brief(title: string): CampaignBrief {
  return {
    kind: 'campaign-brief',
    title,
    audience: 'ops leads',
    deliverables: ['deck', 'doc'],
    key_messages: ['launch update'],
  };
}

describe('campaign landing page design tokens', () => {
  it('resolves the canonical theme when absent and preserves supplied token overrides', () => {
    const tokens = webThemePackToCssVars(DEFAULT_CHRONOS_WEB_THEME_PACK);
    const html = buildLandingPageHtml(brief('Launch'), null, { '--kb-accent': 'rebeccapurple' });
    expect(html).toContain(`--kb-bg-main: ${tokens['--kb-bg-main']};`);
    expect(html).toContain('--kb-accent: rebeccapurple;');
    expect(html).toContain('background: var(--kb-bg-main);');
    expect(html).not.toMatch(/var\(--kb-[^)]*,\s*#/u);
  });
});

describe('buildCampaignPlan output paths (IP-09: canonical slugify)', () => {
  it('slugifies a title with spaces and punctuation the same way the pre-consolidation local slugifyTitle() did', () => {
    const plan = buildCampaignPlan(brief('Q3 Launch: Growth & Retention!'), {
      outputRoot: 'active/shared/tmp/campaign-suite-test',
    });
    const deck = plan.entries.find((e) => e.kind === 'deck')!;
    const doc = plan.entries.find((e) => e.kind === 'doc')!;
    expect((deck.action_input.steps as any[])[0].params.path).toBe(
      'active/shared/tmp/campaign-suite-test/deck/q3-launch-growth-retention.pptx'
    );
    expect((doc.action_input.steps as any[])[0].params.path).toBe(
      'active/shared/tmp/campaign-suite-test/doc/q3-launch-growth-retention.docx'
    );
  });

  it('falls back to "campaign" for a title with no alphanumeric characters', () => {
    const plan = buildCampaignPlan(brief('!!!'), {
      outputRoot: 'active/shared/tmp/campaign-suite-test',
    });
    const deck = plan.entries.find((e) => e.kind === 'deck')!;
    expect((deck.action_input.steps as any[])[0].params.path).toBe(
      'active/shared/tmp/campaign-suite-test/deck/campaign.pptx'
    );
  });

  it('rejects unknown persisted campaign manifest fields', () => {
    const manifest = buildCampaignPlan(brief('Governed manifest'), {
      outputRoot: 'active/shared/tmp/campaign-suite-test',
    }).manifest;

    expect(() => validateCampaignManifest({ ...manifest, unexpected: true })).toThrow(
      'Invalid catalog campaign-manifest'
    );
  });
});

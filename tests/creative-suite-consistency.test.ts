import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCampaignPlan,
  pathResolver,
  renderPromptStyleBlock,
  resolveCreativeDesign,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  type CampaignBrief,
} from '@agent/core';

/**
 * E2E-02 Task 7: "デザインが揃っている" ことの機械検証。
 * A fixture tenant with primary #123456 must surface the same hex in every
 * projection (web/pptx/video/prompt) and in the campaign manifest.
 */

const SLUG = 'e2e02-consistency-fixture';
const PRIMARY = '#123456';
const ACCENT = '#abcdef';

let prevPersona: string | undefined;

describe('creative suite design consistency (E2E-02)', () => {
  beforeAll(() => {
    prevPersona = process.env.KYBERION_PERSONA;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const designDir = pathResolver.knowledge(`confidential/${SLUG}/design`);
    safeMkdir(designDir, { recursive: true });
    safeWriteFile(
      path.join(designDir, 'tenant-override.json'),
      JSON.stringify({ tenant_id: SLUG, branding: { brand_name: 'Consistency Corp' } })
    );
    safeWriteFile(
      path.join(designDir, 'theme.json'),
      JSON.stringify({
        theme: {
          name: SLUG,
          colors: {
            primary: PRIMARY,
            accent: ACCENT,
            background: '#101010',
            text: '#eeeeee',
          },
          fonts: { heading: 'Fixture Sans', body: 'Fixture Sans' },
        },
      })
    );
  });

  afterAll(() => {
    safeRmSync(pathResolver.knowledge(`confidential/${SLUG}`), { recursive: true, force: true });
    if (prevPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = prevPersona;
  });

  it('resolves the identical primary hex across all four projections (G1/G2)', () => {
    const surfaces = ['web', 'pptx', 'video', 'prompt'] as const;
    const primaries = surfaces.map((surface) => {
      const resolved = resolveCreativeDesign({ surface, tenantSlug: SLUG, mode: 'light' });
      expect(resolved.source).toBe('tenant-override');
      return resolved.colors.primary;
    });
    expect(new Set(primaries)).toEqual(new Set([PRIMARY]));
  });

  it('carries the tenant palette into the prompt style block (Task 4)', () => {
    const resolved = resolveCreativeDesign({ surface: 'prompt', tenantSlug: SLUG, mode: 'light' });
    if (resolved.projection.surface !== 'prompt') throw new Error('unexpected projection');
    const block = renderPromptStyleBlock(resolved.projection.style_pack);
    expect(block).toContain(PRIMARY);
    expect(block).toContain(ACCENT);
  });

  it('records one consistent design fingerprint in the campaign manifest (Task 6)', () => {
    const brief: CampaignBrief = {
      kind: 'campaign-brief',
      title: 'Consistency Campaign',
      audience: 'customers',
      tenant_slug: SLUG,
      deliverables: ['deck', 'doc', 'intro_video', 'web_lp'],
      key_messages: ['one design system everywhere'],
    };

    const plan = buildCampaignPlan(brief, { outputRoot: 'active/shared/tmp/e2e02-campaign' });

    expect(plan.entries).toHaveLength(4);
    const hexes = new Set(plan.entries.map((entry) => entry.design.primary_hex));
    expect(hexes).toEqual(new Set([PRIMARY]));
    expect(plan.manifest.primary_hex).toBe(PRIMARY);
    expect(plan.manifest.design_source).toBe('tenant-override');
    expect(plan.manifest.deliverables.map((d) => d.kind)).toEqual([
      'deck',
      'doc',
      'intro_video',
      'web_lp',
    ]);

    // Video entry css_vars carry the same palette (VDS-07 chain).
    const video = plan.entries.find((entry) => entry.kind === 'intro_video');
    const briefParams = (
      video?.action_input as {
        params?: { content_brief?: { design_system_ref?: { css_vars?: Record<string, string> } } };
      }
    )?.params?.content_brief;
    expect(briefParams?.design_system_ref?.css_vars?.['--kb-primary']).toBe(PRIMARY);
  });

  it('falls back to one consistent brand default without a tenant', () => {
    const brief: CampaignBrief = {
      kind: 'campaign-brief',
      title: 'Default Campaign',
      audience: 'ops',
      deliverables: ['deck', 'doc'],
      key_messages: ['brand default'],
    };
    const plan = buildCampaignPlan(brief, {
      outputRoot: 'active/shared/tmp/e2e02-campaign-default',
    });
    const hexes = new Set(plan.entries.map((entry) => entry.design.primary_hex));
    expect(hexes.size).toBe(1);
    expect(plan.manifest.design_source).toBe('brand-default');
  });
});

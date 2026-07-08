import { resolveCreativeDesign, type ResolvedCreativeDesign } from './creative-design-resolver.js';
import { webThemePackToCssVars, type WebThemePack } from './web-design-system.js';

/**
 * E2E-02 Task 6: campaign planner — one brief, one resolved design, N deliverables.
 *
 * `buildCampaignPlan` is pure (no I/O): it resolves the design once per surface
 * through creative-design-resolver and emits, per deliverable, the actuator
 * payload plus the design fingerprint that lands in campaign-manifest.json.
 * Execution (shelling out to actuator CLIs) lives in scripts/campaign_suite.ts.
 */

export type CampaignDeliverableKind = 'deck' | 'doc' | 'intro_video' | 'web_lp' | 'mv';

export interface CampaignBrief {
  kind: 'campaign-brief';
  version?: string;
  title: string;
  audience: string;
  tenant_slug?: string;
  tone?: string;
  language?: string;
  deliverables: CampaignDeliverableKind[];
  key_messages: string[];
  sections?: Array<{ heading: string; body?: string[] }>;
}

export interface CampaignPlanEntry {
  kind: CampaignDeliverableKind;
  output_dir: string;
  /** Actuator id (libs/actuators/<id>) whose CLI executes this deliverable. */
  actuator: 'media-actuator' | 'video-composition-actuator';
  /** JSON payload passed to the actuator CLI via --input file. */
  action_input: Record<string, unknown>;
  design: {
    source: ResolvedCreativeDesign['source'];
    primary_hex: string;
    accent_hex: string;
  };
}

export interface CampaignManifest {
  kind: 'campaign-manifest';
  title: string;
  tenant_slug?: string;
  design_source: ResolvedCreativeDesign['source'];
  primary_hex: string;
  accent_hex: string;
  deliverables: Array<{
    kind: CampaignDeliverableKind;
    output_dir: string;
    status: 'planned' | 'succeeded' | 'failed' | 'skipped';
    detail?: string;
  }>;
  generated_by: string;
}

export interface CampaignPlan {
  entries: CampaignPlanEntry[];
  manifest: CampaignManifest;
}

function briefSections(brief: CampaignBrief): Array<{ heading: string; body: string[] }> {
  if (brief.sections?.length) {
    return brief.sections.map((section) => ({
      heading: section.heading,
      body: section.body || [],
    }));
  }
  return brief.key_messages.map((message, index) => ({
    heading: `Key message ${index + 1}`,
    body: [message],
  }));
}

function buildDocumentBrief(
  brief: CampaignBrief,
  documentType: 'proposal' | 'report',
  renderTarget: 'pptx' | 'docx'
): Record<string, unknown> {
  return {
    kind: 'document-brief',
    artifact_family: 'document',
    document_type: documentType,
    render_target: renderTarget,
    locale: brief.language || 'ja',
    payload: {
      title: brief.title,
      summary: brief.key_messages.join(' / '),
      sections: briefSections(brief),
    },
  };
}

function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'campaign'
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Deterministic landing page from the brief + resolved web theme pack: the
 * campaign's web deliverable is a REAL page in the design system, not a JSON
 * dump. Kept dependency-free (inline CSS from webThemePackToCssVars).
 */
export function buildLandingPageHtml(brief: CampaignBrief, themePack: unknown): string {
  const pack = themePack as WebThemePack | null;
  const cssVars = pack ? webThemePackToCssVars(pack) : {};
  const varLines = Object.entries(cssVars)
    .map(([key, value]) => `      ${key}: ${value};`)
    .join('\n');
  const heading = pack?.theme.fonts.heading || 'Inter, sans-serif';
  const sections = briefSections(brief)
    .map(
      (section) => `      <section class="panel">
        <h2>${escapeHtml(section.heading)}</h2>
        <ul>
${(section.body || []).map((line) => `          <li>${escapeHtml(line)}</li>`).join('\n')}
        </ul>
      </section>`
    )
    .join('\n');
  const messages = brief.key_messages
    .map((message) => `          <li>${escapeHtml(message)}</li>`)
    .join('\n');
  return `<!doctype html>
<html lang="${escapeHtml(brief.language || 'ja')}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      :root {
${varLines}
      }
      * { box-sizing: border-box; margin: 0; }
      body {
        background: var(--kb-bg-main, #020617);
        color: var(--kb-text-primary, #e2e8f0);
        font-family: var(--kb-font-sans, 'Inter', sans-serif);
        line-height: 1.7;
      }
      main { max-width: 960px; margin: 0 auto; padding: 48px 24px 96px; }
      .hero { padding: 72px 0 40px; border-bottom: var(--kb-border, 1px solid rgba(226,232,240,0.1)); }
      .hero h1 { font-family: ${heading}; font-size: 2.6rem; letter-spacing: -0.02em; }
      .hero p.audience { color: var(--kb-text-secondary, #94a3b8); margin-top: 12px; }
      .hero ul { margin: 28px 0 0 1.2em; }
      .hero li { margin: 8px 0; }
      .hero li::marker { color: var(--kb-accent, #38bdf8); }
      .panel {
        /* panel derives from the page background, not the dark-console panel
           token — keeps light brand themes readable. */
        background: color-mix(in srgb, var(--kb-accent, #38bdf8) 7%, var(--kb-bg-main, #020617));
        border: var(--kb-border, 1px solid rgba(226,232,240,0.1));
        border-radius: 14px;
        padding: 28px 32px;
        margin-top: 28px;
        box-shadow: var(--kb-glow-cyan, none);
      }
      .panel h2 { font-family: ${heading}; font-size: 1.35rem; margin-bottom: 12px; color: var(--kb-accent, #38bdf8); }
      .panel ul { margin-left: 1.2em; }
      .panel li { margin: 6px 0; }
      footer { margin-top: 48px; color: var(--kb-text-secondary, #94a3b8); font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <main>
      <header class="hero">
        <h1>${escapeHtml(brief.title)}</h1>
        <p class="audience">${escapeHtml(brief.audience)}</p>
        <ul>
${messages}
        </ul>
      </header>
${sections}
      <footer>Generated by Kyberion campaign-suite — design system: ${escapeHtml(pack?.design_system_id || 'brand-default')}</footer>
    </main>
  </body>
</html>
`;
}

export function buildCampaignPlan(
  brief: CampaignBrief,
  options: { outputRoot: string }
): CampaignPlan {
  const tenantSlug = brief.tenant_slug;
  const entries: CampaignPlanEntry[] = [];
  // Resolve once per surface — the single-resolution invariant of E2E-02.
  const designFor = (surface: 'pptx' | 'doc' | 'video' | 'web') => {
    const resolved = resolveCreativeDesign({ surface, tenantSlug, mode: 'light' });
    return {
      resolved,
      fingerprint: {
        source: resolved.source,
        primary_hex: resolved.colors.primary,
        accent_hex: resolved.colors.accent,
      },
    };
  };

  for (const kind of brief.deliverables) {
    const outputDir = `${options.outputRoot}/${kind}`;
    if (kind === 'deck') {
      const { fingerprint } = designFor('pptx');
      entries.push({
        kind,
        output_dir: outputDir,
        actuator: 'media-actuator',
        action_input: {
          action: 'pipeline',
          context: { last_json: buildDocumentBrief(brief, 'proposal', 'pptx') },
          steps: [
            {
              type: 'apply',
              op: 'generate_document',
              params: {
                from: 'last_json',
                render_target: 'pptx',
                path: `${outputDir}/${slugifyTitle(brief.title)}.pptx`,
              },
            },
          ],
        },
        design: fingerprint,
      });
    } else if (kind === 'doc') {
      const { fingerprint } = designFor('doc');
      entries.push({
        kind,
        output_dir: outputDir,
        actuator: 'media-actuator',
        action_input: {
          action: 'pipeline',
          context: { last_json: buildDocumentBrief(brief, 'report', 'docx') },
          steps: [
            {
              type: 'apply',
              op: 'generate_document',
              params: {
                from: 'last_json',
                render_target: 'docx',
                path: `${outputDir}/${slugifyTitle(brief.title)}.docx`,
              },
            },
          ],
        },
        design: fingerprint,
      });
    } else if (kind === 'intro_video' || kind === 'mv') {
      const { resolved, fingerprint } = designFor('video');
      const cssVars = resolved.projection.surface === 'video' ? resolved.projection.css_vars : {};
      entries.push({
        kind,
        output_dir: outputDir,
        actuator: 'video-composition-actuator',
        action_input: {
          action: 'compile_video_content_brief',
          params: {
            content_brief: {
              kind: 'video-content-brief',
              version: '1.0.0',
              title: brief.title,
              audience: brief.audience,
              objective: brief.key_messages[0] || brief.title,
              distribution_channel: 'campaign',
              content_type: kind === 'mv' ? 'promo' : 'howto',
              presentation_mode: kind === 'mv' ? 'promo' : 'howto',
              promise: brief.key_messages[0] || brief.title,
              desired_takeaway: brief.key_messages.join(' / '),
              constraints: [],
              proof_points: brief.key_messages,
              content_requirements: briefSections(brief).map((section) => section.heading),
              tone: brief.tone || 'practical',
              language: brief.language || 'ja',
              duration_sec: kind === 'mv' ? 60 : 20,
              ...(tenantSlug ? { design_profile: { tenant_slug: tenantSlug } } : {}),
              design_system_ref: { system_id: 'campaign', css_vars: cssVars },
            },
            export_as: `campaign_${kind}_storyboard`,
          },
        },
        design: fingerprint,
      });
    } else if (kind === 'web_lp') {
      const { resolved, fingerprint } = designFor('web');
      const themePack =
        resolved.projection.surface === 'web' ? resolved.projection.theme_pack : null;
      entries.push({
        kind,
        output_dir: outputDir,
        actuator: 'media-actuator',
        action_input: {
          action: 'pipeline',
          context: {
            // write_file writes strings — pre-serialize so the pipeline is
            // deterministic and the LP is a real page, not raw JSON dumps.
            web_theme_pack_json: JSON.stringify(themePack, null, 2),
            lp_html: buildLandingPageHtml(brief, themePack),
          },
          steps: [
            {
              type: 'apply',
              op: 'write_file',
              params: { path: `${outputDir}/index.html`, from: 'lp_html' },
            },
            {
              type: 'apply',
              op: 'write_file',
              params: { path: `${outputDir}/web-theme-pack.json`, from: 'web_theme_pack_json' },
            },
          ],
        },
        design: fingerprint,
      });
    }
  }

  const primary = entries[0]?.design.primary_hex || '';
  const manifest: CampaignManifest = {
    kind: 'campaign-manifest',
    title: brief.title,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    design_source: entries[0]?.design.source || 'brand-default',
    primary_hex: primary,
    accent_hex: entries[0]?.design.accent_hex || '',
    deliverables: entries.map((entry) => ({
      kind: entry.kind,
      output_dir: entry.output_dir,
      status: 'planned',
    })),
    generated_by: 'kyberion:campaign-suite',
  };

  return { entries, manifest };
}

import { resolveCreativeDesign, type ResolvedCreativeDesign } from './creative-design-resolver.js';

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
              type: 'transform',
              op: 'document_binary_from_brief',
              params: { from: 'last_json', output_dir: outputDir, export_as: 'campaign_deck' },
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
              type: 'transform',
              op: 'document_binary_from_brief',
              params: { from: 'last_json', output_dir: outputDir, export_as: 'campaign_doc' },
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
            web_theme_pack: themePack,
            lp_sections: briefSections(brief),
            lp_title: brief.title,
          },
          steps: [
            {
              type: 'apply',
              op: 'write_file',
              params: {
                path: `${outputDir}/web-theme-pack.json`,
                from: 'web_theme_pack',
                format: 'json',
              },
            },
            {
              type: 'apply',
              op: 'write_file',
              params: {
                path: `${outputDir}/lp-sections.json`,
                from: 'lp_sections',
                format: 'json',
              },
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

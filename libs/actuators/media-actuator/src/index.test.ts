import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync, saveProjectRecord, saveServiceBindingRecord } from '@agent/core';

const mocks = vi.hoisted(() => ({
  recognize: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  default: {
    recognize: mocks.recognize,
  },
  recognize: mocks.recognize,
}));

import { handleAction } from './index.js';

describe('media-actuator pdf to pptx bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves tenant branding from project and service binding metadata', async () => {
    saveServiceBindingRecord({
      binding_id: 'BIND-MEDIA-BRAND',
      service_type: 'client-branding',
      scope: 'project',
      target: 'branding',
      allowed_actions: ['read'],
      secret_refs: [],
      approval_policy: { read: 'allowed' },
      metadata: {
        client_key: 'client-a',
        branding: {
          brand_name: 'Aster Bank',
          tone: 'corporate',
        },
      },
    });
    saveProjectRecord({
      project_id: 'PRJ-MEDIA-BRAND',
      name: 'Aster Experience Program',
      summary: 'Brand-aware media generation test',
      status: 'active',
      tier: 'public',
      service_bindings: ['BIND-MEDIA-BRAND'],
      metadata: {
        tenant_id: 'client-a',
      },
    });

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'proposal-brief',
          project_id: 'PRJ-MEDIA-BRAND',
          document_profile: 'executive-proposal',
          layout_template_id: 'executive-neutral',
          render_target: 'pptx',
          locale: 'en-US',
          title: 'Brand-Aware Proposal',
          objective: 'Validate project/service-binding driven design resolution.',
          story: {
            core_message: 'Branding should resolve without direct client text.',
            closing_cta: 'Approve the next step.',
          },
          evidence: [{ title: 'Evidence', point: 'Bound branding is available.' }],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_outline_from_brief',
          params: { from: 'last_json', export_as: 'document_outline' },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline.recommended_theme).toBe('client-a');
    expect(result.context.document_outline.branding).toEqual(
      expect.objectContaining({
        brand_name: 'Aster Bank',
        tone: 'corporate',
      }),
    );
  });

  it('resolves imported DESIGN.md systems as explicit media design systems', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'proposal-brief',
          document_profile: 'executive-proposal',
          design_system_id: 'designmd-apple',
          render_target: 'pptx',
          locale: 'en-US',
          title: 'Apple Referenced Proposal',
          objective: 'Validate imported DESIGN.md catalog resolution.',
          story: {
            core_message: 'Imported design systems should resolve through the standard loader.',
            closing_cta: 'Approve the style direction.',
          },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_outline_from_brief',
          params: { from: 'last_json', export_as: 'document_outline' },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline.design_system_id).toBe('designmd-apple');
    expect(result.context.document_outline.recommended_theme).toBe('designmd-apple');
    expect(result.context.document_outline.branding).toEqual(
      expect.objectContaining({
        brand_name: 'Apple',
      }),
    );
    expect(result.context.document_outline.prompt_guide).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Primary CTA'),
      ]),
    );
    expect(result.context.document_outline.source_design).toEqual(
      expect.objectContaining({
        source_type: 'design-md',
        slug: 'apple',
      }),
    );
  });

  it('auto-binds imported DESIGN.md systems from service binding design_reference metadata', async () => {
    saveServiceBindingRecord({
      binding_id: 'BIND-DESIGN-REF',
      service_type: 'design-reference',
      scope: 'project',
      target: 'design-system',
      allowed_actions: ['read'],
      secret_refs: [],
      approval_policy: { read: 'allowed' },
      metadata: {
        design_reference: 'vercel',
      },
    });
    saveProjectRecord({
      project_id: 'PRJ-DESIGN-REF',
      name: 'Frontend Refresh',
      summary: 'Imported DESIGN.md auto-binding test',
      status: 'active',
      tier: 'public',
      service_bindings: ['BIND-DESIGN-REF'],
      metadata: {},
    });

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'proposal-brief',
          document_profile: 'executive-proposal',
          project_id: 'PRJ-DESIGN-REF',
          render_target: 'pptx',
          locale: 'en-US',
          title: 'Vercel Referenced Proposal',
          objective: 'Resolve imported design system from binding metadata.',
          story: {
            core_message: 'Binding metadata should steer design system selection.',
            closing_cta: 'Continue with implementation.',
          },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_outline_from_brief',
          params: { from: 'last_json', export_as: 'document_outline' },
        },
        {
          type: 'transform',
          op: 'brief_to_design_protocol',
          params: { from: 'last_json', export_as: 'compiled_protocol' },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline.design_system_id).toBe('designmd-vercel');
    expect(result.context.document_outline.recommended_theme).toBe('designmd-vercel');
    expect(result.context.compiled_protocol.metadata.sourceDesign).toEqual(
      expect.objectContaining({
        slug: 'vercel',
      }),
    );
    expect(result.context.compiled_protocol.metadata.promptGuide).toEqual(
      expect.arrayContaining([
        expect.any(String),
      ]),
    );
  });

  it('recommends imported DESIGN.md systems from brief semantics without overriding the active system', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'proposal-brief',
          document_profile: 'executive-proposal',
          render_target: 'pptx',
          locale: 'en-US',
          title: 'Frontend Deployment Platform Launch',
          objective: 'Prepare a polished launch proposal for a frontend deployment platform with developer infrastructure emphasis.',
          story: {
            core_message: 'The experience should feel precise, technical, and product-led for frontend platform teams.',
            closing_cta: 'Approve the rollout.',
          },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_outline_from_brief',
          params: { from: 'last_json', export_as: 'document_outline' },
        },
        {
          type: 'transform',
          op: 'brief_to_design_protocol',
          params: { from: 'last_json', export_as: 'compiled_protocol' },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline.design_system_id).not.toBe('designmd-vercel');
    expect(result.context.document_outline.design_recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          design_system_id: 'designmd-vercel',
        }),
      ]),
    );
    expect(result.context.compiled_protocol.metadata.designRecommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          design_system_id: 'designmd-vercel',
        }),
      ]),
    );
  });

  it('resolves high-fidelity artifact-library profiles during outline generation', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'assessment',
          document_profile: 'vendor-risk-assessment-v2',
          render_target: 'docx',
          locale: 'en-US',
          title: 'Vendor Risk Assessment',
          objective: 'Assess third-party governance and resilience risk.',
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_outline_from_brief',
          params: { from: 'last_json', export_as: 'document_outline' },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline.document_profile).toBe('vendor-risk-assessment-v2');
    expect(result.context.document_outline.toc).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Vendor Profile and Criticality' }),
        expect.objectContaining({ title: 'Recommendation and Conditions' }),
      ]),
    );
  });

  it('compiles a proposal brief into a pptx design protocol', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'proposal-brief',
          document_profile: 'executive-proposal',
          render_target: 'pptx',
          locale: 'en-US',
          title: 'Protocol Compiler Proposal',
          objective: 'Validate brief to protocol compilation.',
          story: {
            core_message: 'Compiler should bridge brief and renderer.',
            closing_cta: 'Approve generation.',
          },
          evidence: [{ title: 'Evidence', point: 'Protocol produced from brief.' }],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'brief_to_design_protocol',
          params: { from: 'last_json', export_as: 'compiled_protocol' },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.compiled_protocol.version).toBe('3.0.0');
    expect(Array.isArray(result.context.compiled_protocol.slides)).toBe(true);
    expect(result.context.last_design_protocol_kind).toBe('pptx');
    expect(result.context.document_outline.document_profile).toBe('executive-proposal');
    expect(result.context.document_outline.generation_boundary.rule).toContain('sections-first');
    expect(result.context.compiled_protocol.metadata.generationBoundary.llm_zone.forbidden).toEqual(
      expect.arrayContaining(['invent_layout_coordinates']),
    );
  });

  it('renders xlsx from a minimal smart-table protocol without explicit table metadata', async () => {
    const outputPath = 'active/shared/tmp/media/smart-table-render.xlsx';
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath, { force: true });
    }

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_xlsx_design: {
          version: '3.0.0',
          generatedAt: new Date().toISOString(),
          theme: { colors: { primary: '0f172a', accent1: '38bdf8' } },
          styles: {},
          sheets: [
            {
              name: 'Work Items',
              smart_table: {
                headers: ['Task', 'Status'],
                rows: [
                  ['Close actions', 'Open'],
                  ['Verify fixes', 'Planned'],
                ],
              },
            },
          ],
        },
      },
      steps: [
        {
          type: 'apply',
          op: 'xlsx_render',
          params: { path: outputPath },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(safeExistsSync(outputPath)).toBe(true);
  });

  it('generates a proposal binary directly from a unified document request', async () => {
    const outputPath = 'active/shared/tmp/media/unified-generate-proposal.pptx';
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath, { force: true });
    }

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'generate_document',
          params: {
            profile_id: 'executive-proposal',
            render_target: 'pptx',
            output_path: outputPath,
            data: {
              title: 'Unified Generator Proposal',
              objective: 'Collapse intent-to-binary flow.',
              story: {
                core_message: 'One op should generate the artifact.',
                closing_cta: 'Proceed with the rollout.',
              },
              evidence: [{ title: 'Benefit', point: 'Pipeline definitions get shorter.' }],
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(safeExistsSync(outputPath)).toBe(true);
  });

  it('generates a report binary directly from a unified document request', async () => {
    const outputPath = 'active/shared/tmp/media/unified-generate-report.docx';
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath, { force: true });
    }

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'generate_document',
          params: {
            profile_id: 'summary-report',
            render_target: 'docx',
            output_path: outputPath,
            data: {
              title: 'Quarterly Reliability Review',
              summary: 'Reliability posture improved across the quarter.',
              sections: [
                {
                  heading: 'Incident Themes',
                  body: ['Three recurring failure modes were reduced after remediation.'],
                  bullets: ['Gateway timeout handling improved', 'Retry policy standardized'],
                },
              ],
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(safeExistsSync(outputPath)).toBe(true);
  });

  it('generates a tracker binary directly from a unified document request', async () => {
    const outputPath = 'active/shared/tmp/media/unified-generate-tracker.xlsx';
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath, { force: true });
    }

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'generate_document',
          params: {
            profile_id: 'operator-tracker',
            render_target: 'xlsx',
            output_path: outputPath,
            data: {
              payload: {
                title: 'Execution Tracker',
                columns: [
                  { key: 'task', label: 'Task' },
                  { key: 'owner', label: 'Owner' },
                  { key: 'status', label: 'Status' },
                ],
                rows: [
                  { task: 'Close incident actions', owner: 'Ops', status: 'In Progress' },
                ],
              },
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(safeExistsSync(outputPath)).toBe(true);
  });

  it('uses document profile sections when generating a requirements deck as pptx', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'specification',
          document_profile: 'requirements-definition',
          render_target: 'pptx',
          locale: 'ja-JP',
          title: '要件定義書',
          objective: '要件のベースラインを定義する。',
          story: {
            chapters: [
              '対象スコープと目的を定義する。',
              '主要な機能要求を整理する。',
              '品質・性能・統制要件を定義する。',
              '情報資産と責任境界を定義する。',
              '要求からテストまでの対応を明示する。'
            ],
          },
          evidence: [
            { title: 'Scope', point: '対象範囲を固定する。' },
            { title: 'Functional', point: '機能要求を明確化する。' },
            { title: 'Non-Functional', point: '品質要求を明確化する。' },
            { title: 'Assets', point: '情報資産を整理する。' },
            { title: 'Traceability', point: '追跡可能性を担保する。' },
          ],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'brief_to_design_protocol',
          params: { from: 'last_json', export_as: 'compiled_protocol' },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline.document_profile).toBe('requirements-definition');
    expect(result.context.document_outline.toc).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section_id: 'scope', title: 'Scope and Objectives' }),
        expect.objectContaining({ section_id: 'functional', title: 'Functional Requirements' }),
        expect.objectContaining({ section_id: 'traceability', title: 'Traceability Matrix' }),
      ]),
    );
    expect(result.context.compiled_protocol.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({ layoutKey: 'doc-summary' }) }),
        expect.objectContaining({ metadata: expect.objectContaining({ layoutKey: 'doc-sections' }) }),
        expect.objectContaining({ metadata: expect.objectContaining({ layoutKey: 'sheet-main-table' }) }),
      ]),
    );
  });

  it('renders a drawio diagram file directly from a document brief', async () => {
    const outputPath = 'active/shared/tmp/media/document-brief-direct-render.drawio';
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath, { force: true });
    }

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'document_diagram_render_from_brief',
          params: {
            brief: {
              kind: 'document-brief',
              artifact_family: 'diagram',
              document_type: 'architecture-diagram',
              document_profile: 'solution-overview',
              render_target: 'drawio',
              locale: 'en-US',
              layout_template_id: 'kyberion-sovereign',
              payload: {
                title: 'Kyberion Overview',
                graph: {
                  nodes: [
                    { id: 'intent', type: 'generic', label: 'Intent' },
                    { id: 'work', type: 'generic', label: 'Work Loop' },
                  ],
                  edges: [
                    { id: 'edge-1', from: 'intent', to: 'work', label: 'resolves to' },
                  ],
                },
              },
            },
            path: outputPath,
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(safeExistsSync(outputPath)).toBe(true);
    const content = safeReadFile(outputPath, { encoding: 'utf8' }) as string;
    expect(content).toContain('Kyberion Overview');
    expect(content).toContain('value="intent"');
    expect(content).toContain('value="work"');
  });

  it('builds a document outline from a proposal brief with narrative and layout recommendations', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'proposal-brief',
          document_profile: 'executive-proposal',
          layout_template_id: 'executive-neutral',
          render_target: 'pptx',
          locale: 'en-US',
          title: 'Digital Onboarding Transformation Proposal',
          client: 'Aster Bank',
          objective: 'Redesign onboarding and approval journeys to improve conversion and operational efficiency.',
          audience: ['Executive Sponsor', 'Digital Channel Lead', 'Operations Manager'],
          story: {
            core_message: 'A lighter, guided onboarding experience reduces drop-off while preserving governance.',
            tone: 'executive and evidence-based',
            closing_cta: 'Approve the discovery and pilot phase.',
          },
          evidence: [
            { title: 'Current pain points', point: 'Existing onboarding creates avoidable abandonment.' },
            { title: 'Future-state journey', point: 'A guided journey aligns intent, verification, and support.' },
            { title: 'Governance design', point: 'Controls are embedded without exposing back-office complexity.' },
            { title: 'Pilot roadmap', point: 'A phased rollout de-risks delivery while creating wins.' }
          ],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_outline_from_brief',
          params: {
            from: 'last_json',
            export_as: 'document_outline',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline).toEqual(
      expect.objectContaining({
        kind: 'document-outline-adf',
        document_profile: 'executive-proposal',
        design_system_id: 'executive-standard',
        narrative_pattern_id: 'problem-solution-executive',
        recommended_theme: 'client-a',
        recommended_layout_template_id: 'executive-neutral',
      }),
    );
    expect(result.context.document_outline.branding).toEqual(
      expect.objectContaining({
        brand_name: 'Aster Bank',
        logo_url: '/vault/tenants/client-a/logo.png',
        tone: 'corporate',
      }),
    );
    expect(result.context.document_outline.toc.length).toBeGreaterThanOrEqual(6);
    expect(result.context.document_outline.toc).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section_id: 'executive-summary', layout_key: 'title-body' }),
        expect.objectContaining({ section_id: 'governance', media_kind: 'controls' }),
      ]),
    );
  });

  it('expands proposal storyline into a multi-angle slide sequence from composition presets', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'proposal-brief',
          document_profile: 'executive-proposal',
          layout_template_id: 'executive-neutral',
          render_target: 'pptx',
          locale: 'en-US',
          title: 'Digital Onboarding Transformation Proposal',
          client: 'Aster Bank',
          objective: 'Redesign onboarding and approval journeys to improve conversion and operational efficiency.',
          audience: ['Executive Sponsor', 'Digital Channel Lead', 'Operations Manager'],
          story: {
            core_message: 'A lighter, guided onboarding experience reduces drop-off while preserving governance.',
            tone: 'executive and evidence-based',
            closing_cta: 'Approve the discovery and pilot phase.',
          },
          evidence: [
            { title: 'Current pain points', point: 'Existing onboarding creates avoidable abandonment.' },
            { title: 'Future-state journey', point: 'A guided journey aligns intent, verification, and support.' },
            { title: 'Governance design', point: 'Controls are embedded without exposing back-office complexity.' },
            { title: 'Pilot roadmap', point: 'A phased rollout de-risks delivery while creating wins.' }
          ],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'proposal_storyline_from_brief',
          params: {
            from: 'last_json',
            export_as: 'proposal_storyline',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.proposal_storyline.narrative_pattern_id).toBe('problem-solution-executive');
    expect(result.context.proposal_storyline.design_system_id).toBe('executive-standard');
    expect(result.context.proposal_storyline.branding.brand_name).toBe('Aster Bank');
    expect(result.context.proposal_storyline.slides.length).toBeGreaterThanOrEqual(6);
    expect(result.context.proposal_storyline.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'why-change', layout_key: 'evidence-callout' }),
        expect.objectContaining({ id: 'delivery-plan', media_kind: 'timeline' }),
        expect.objectContaining({ id: 'decision', layout_key: 'decision-cta' }),
      ]),
    );
    expect(result.context.proposal_storyline.slides[0].design_system_id).toBe('executive-standard');
    expect(result.context.proposal_storyline.slides[0].branding.brand_name).toBe('Aster Bank');
  });

  it('applies layout_key-aware slide rendering presets during merge_content', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        active_theme: {
          colors: {
            primary: '#1f2937',
            secondary: '#4b5563',
            accent: '#2563eb',
            background: '#ffffff',
            text: '#111827',
          },
          fonts: {
            heading: 'Inter, sans-serif',
            body: 'Arial, sans-serif',
          },
        },
        active_pattern: {},
      },
      steps: [
        {
          type: 'transform',
          op: 'merge_content',
          params: {
            output_format: 'pptx',
            content_data: [
              {
                id: 'slide-evidence',
                title: 'Why Change Now',
                body: ['Current onboarding creates avoidable abandonment.'],
                visual: 'Pain point evidence',
                layout_key: 'evidence-callout',
                media_kind: 'evidence',
              },
              {
                id: 'slide-timeline',
                title: 'Delivery Plan',
                body: ['Phase 1: Discover', 'Phase 2: Pilot'],
                visual: 'Roadmap / milestones',
                layout_key: 'timeline-roadmap',
                media_kind: 'timeline',
              },
            ],
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const evidenceSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'slide-evidence');
    const timelineSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'slide-timeline');
    const evidenceBody = evidenceSlide.elements.find((element: any) => element.placeholderType === 'body');
    const timelineBody = timelineSlide.elements.find((element: any) => element.placeholderType === 'body');

    expect(evidenceSlide.metadata.layoutKey).toBe('evidence-callout');
    expect(evidenceSlide.metadata.semanticType).toBe('evidence');
    expect(timelineSlide.metadata.layoutKey).toBe('timeline-roadmap');
    expect(timelineSlide.metadata.semanticType).toBe('roadmap');
    expect(evidenceBody.pos.w).not.toBe(timelineBody.pos.w);
    expect(evidenceSlide.elements.find((element: any) => String(element.text || '').includes('Pain point evidence'))?.pos.w).not.toBe(
      timelineSlide.elements.find((element: any) => String(element.text || '').includes('Roadmap / milestones'))?.pos.w,
    );
    expect(evidenceSlide.elements.find((element: any) => String(element.text || '').includes('Pain point evidence'))?.style.fill).toBe('2563eb');
    expect(timelineSlide.elements.find((element: any) => String(element.text || '').includes('Roadmap / milestones'))?.style.fill).toBe('DCFCE7');
  });

  it('applies the recommended document theme to report design output', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'report',
          document_profile: 'summary-report',
          render_target: 'docx',
          locale: 'en-US',
          payload: {
            title: 'Quarterly Reliability Review',
            summary: 'Reliability and incident posture improved across the quarter.',
            sections: [
              {
                heading: 'Incident Themes',
                body: ['Three recurring failure modes were reduced after remediation.'],
                bullets: ['Gateway timeout handling improved', 'Retry policy standardized'],
              },
            ],
          },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_report_design_from_brief',
          params: {
            from: 'last_json',
            export_as: 'report_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.active_theme_name).toBe('kyberion-standard');
    expect(result.context.report_design.theme.colors).toEqual(
      expect.objectContaining({
        dk1: '0f172a',
        accent1: '38bdf8',
      }),
    );
    expect(result.context.report_design.theme.minorFont).toContain('System-ui');
  });

  it('classifies appendix sections in report outlines and carries composition metadata', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'document-brief',
          artifact_family: 'document',
          document_type: 'report',
          document_profile: 'summary-report',
          render_target: 'docx',
          locale: 'en-US',
          payload: {
            title: 'Operational Review',
            summary: 'Quarterly review of delivery and incident posture.',
            sections: [
              { heading: 'Delivery Overview', body: ['Delivery stabilized across the quarter.'] },
              { heading: 'Appendix A: Incident Timeline', body: ['Detailed incident timeline and actions.'] },
            ],
          },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_report_design_from_brief',
          params: {
            from: 'last_json',
            export_as: 'report_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.document_outline.toc).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section_id: 'appendix-a-incident-timeline', layout_key: 'doc-appendix', media_kind: 'appendix' }),
      ]),
    );
    expect(result.context.report_design.metadata.composition.document_profile).toBe('summary-report');
    expect(result.context.report_design.metadata.sectionSemantics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section_id: 'summary', semantic_type: 'summary' }),
        expect.objectContaining({ section_id: 'appendix-a-incident-timeline', semantic_type: 'appendix' }),
      ]),
    );
    expect(result.context.report_design.styles.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ styleId: 'CalloutTitle' }),
        expect.objectContaining({ styleId: 'CalloutBody' }),
        expect.objectContaining({ styleId: 'TableCaption' }),
        expect.objectContaining({ styleId: 'AppendixBody' }),
      ]),
    );
    expect(result.context.report_design.styles.definitions.find((style: any) => style.styleId === 'CalloutTitle')?.rPr.color.val).toBe('38bdf8');
    expect(result.context.report_design.styles.definitions.find((style: any) => style.styleId === 'AppendixBody')?.rPr.color.val).toBe('334155');
  });

  it('applies the recommended document theme to tracker spreadsheet design output', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_json: {
          kind: 'document-brief',
          artifact_family: 'spreadsheet',
          document_type: 'tracker',
          document_profile: 'operator-tracker',
          render_target: 'xlsx',
          locale: 'en-US',
          payload: {
            title: 'Execution Tracker',
            summary_cards: [{ label: 'Open risks', value: '4', tone: 'warning' }],
            risks: [
              { title: 'Vendor dependency slippage', owner: 'PMO', severity: 'warning' },
            ],
            incidents: [
              { title: 'Payment timeout spike', owner: 'Platform', severity: 'danger' },
            ],
            columns: [
              { key: 'task', label: 'Task' },
              { key: 'owner', label: 'Owner' },
              { key: 'status', label: 'Status' },
            ],
            rows: [
              { task: 'Close incident actions', owner: 'Ops', status: 'In Progress' },
            ],
          },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'document_spreadsheet_design_from_brief',
          params: {
            from: 'last_json',
            export_as: 'tracker_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.active_theme_name).toBe('kyberion-standard');
    expect(result.context.tracker_design.theme.colors).toEqual(
      expect.objectContaining({
        dk1: '0f172a',
        accent1: '38bdf8',
      }),
    );
    expect(result.context.tracker_design.styles.fills[2].fgColor.rgb).toBe('#0f172a');
    expect(result.context.tracker_design.metadata.sheetRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'overview', title: 'Overview' }),
        expect.objectContaining({ role: 'execution-board', title: 'Execution Board' }),
        expect.objectContaining({ role: 'signals', title: 'Signals and Risks' }),
      ]),
    );
    expect(result.context.tracker_design.metadata.sheetSemantics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'overview', semantic_type: 'summary' }),
        expect.objectContaining({ role: 'execution-board', semantic_type: 'execution' }),
        expect.objectContaining({ role: 'signals', semantic_type: 'signals' }),
      ]),
    );
    expect(result.context.tracker_design.sheets.find((sheet: any) => sheet.id === 'sheet1')?.name).toBe('Execution Board');
    expect(result.context.tracker_design.sheets.map((sheet: any) => sheet.name)).toEqual(
      expect.arrayContaining(['Overview', 'Execution Board', 'Signals and Risks']),
    );
    const signalsSheet = result.context.tracker_design.sheets.find((sheet: any) => sheet.id === 'sheet-signals');
    expect(signalsSheet.rows.some((row: any) => row.cells.some((cell: any) => cell.value === 'Vendor dependency slippage'))).toBe(true);
    expect(signalsSheet.rows.some((row: any) => row.cells.some((cell: any) => cell.value === 'Payment timeout spike'))).toBe(true);
    const signalTaskRows = signalsSheet.rows
      .filter((row: any) => row.index >= 4)
      .map((row: any) => row.cells.find((cell: any) => String(cell.ref).startsWith('A'))?.value)
      .filter(Boolean);
    expect(signalTaskRows[0]).toBe('Payment timeout spike');
  });

  it('bridges pdf design into pptx design before render', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Dummy PDF file' },
          content: {
            text: 'First line\nSecond line',
            pages: [
              { pageNumber: 1, width: 612, height: 792, text: 'Page one summary\nDetail A' },
            ],
          },
          metadata: { title: 'Dummy PDF file', pageCount: 1 },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.last_pptx_design).toEqual(
      expect.objectContaining({
        slides: expect.arrayContaining([
          expect.objectContaining({ id: 'pdf-title' }),
          expect.objectContaining({ id: 'pdf-page-1' }),
        ]),
      }),
    );
  });

  it('normalizes octal/pdf bullet text and groups positioned lines into readable slide elements', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'PDF Layout' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 600,
                height: 800,
                text: '',
                elements: [
                  { type: 'text', x: 25, y: 40, width: 80, height: 12, text: 'G=G{GGG9G', fontSize: 10 },
                  { type: 'text', x: 40, y: 60, width: 120, height: 12, text: '', fontSize: 10 },
                  { type: 'text', x: 58, y: 60, width: 280, height: 12, text: 'p.4\\2267', fontSize: 10 },
                  { type: 'text', x: 58, y: 60, width: 280, height: 12, text: '実施概要', fontSize: 10 },
                ],
              },
            ],
          },
          metadata: { title: 'PDF Layout', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => typeof element.text === 'string' && element.text.includes('• p.4–7 実施概要'))).toBe(true);
    expect(pageSlide.elements.some((element: any) => typeof element.text === 'string' && element.text.includes('G=G{GGG9G'))).toBe(false);
    expect(pageSlide.elements.filter((element: any) => typeof element.text === 'string' && element.text.includes('自由回答')).length).toBeLessThanOrEqual(1);
  });

  it('falls back to summary mode for grid-like pptx-exported pdf pages', async () => {
    const elements = [];
    for (let i = 0; i < 80; i++) {
      elements.push({
        type: 'text',
        x: (i % 20) * 22,
        y: 40 + Math.floor(i / 20) * 10,
        width: 18,
        height: 10,
        text: i % 3 === 0 ? 'G=G{GGG9G' : '✓',
      });
    }

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Grid PDF' },
          content: {
            text: 'Readable fallback text',
            pages: [
              {
                pageNumber: 1,
                width: 600,
                height: 800,
                text: [
                  'カテゴリ\t選択肢\t回答方法\t質問文',
                  'スキルインプット',
                  '1~6 +自由回答',
                  '本日のスキルインプットセッションの満足度はどの程度ですか',
                  '役立つ/特に役立たない\t1~2',
                  '本日のセッションで学んだ内容は今後のキャリアに活かせそうですか',
                ].join('\n'),
                elements,
              },
            ],
          },
          metadata: { title: 'Grid PDF', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements[0].text).toBe('Page 1');
    expect(pageSlide.elements[1].text).toContain('本日のスキルインプットセッションの満足度はどの程度ですか');
    expect(pageSlide.elements[1].text).toContain('本日のセッションで学んだ内容は今後のキャリアに活かせそうですか');
  });

  it('maps pdf clip regions to pptx image crop when an image is partially clipped', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Clipped PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/mock-image.png', x: 20, y: 10, width: 120, height: 60 },
                ],
                elements: [
                  { type: 'clip', x: 50, y: 20, width: 60, height: 30, text: '', fontSize: 0, fontName: '' },
                ],
              },
            ],
          },
          metadata: { title: 'Clipped PDF', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    const image = pageSlide.elements.find((element: any) => element.type === 'image');
    expect(image.crop).toEqual({
      left: 25000,
      top: 16667,
      right: 25000,
      bottom: 33333,
    });
    expect(image.pos).toEqual(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        w: expect.any(Number),
        h: expect.any(Number),
      }),
    );
  });

  it('uses clip regions as pptx layout blocks and filters text outside the active clip', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Clipped Layout PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                elements: [
                  { type: 'clip', x: 20, y: 10, width: 100, height: 50, text: '', fontSize: 0, fontName: '' },
                  { type: 'rect', x: 18, y: 8, width: 104, height: 54, fillColor: '#DDEEFF', strokeColor: '#112233', opacity: 0.35 },
                  { type: 'border', x: 20, y: 10, width: 100, height: 1, strokeColor: '#445566', lineWidth: 2 },
                  { type: 'text', x: 30, y: 20, width: 60, height: 10, text: 'Inside block', fontSize: 12 },
                  { type: 'text', x: 150, y: 20, width: 35, height: 10, text: 'Outside block', fontSize: 12 },
                ],
              },
            ],
          },
          metadata: { title: 'Clipped Layout PDF', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    const clipShape = pageSlide.elements.find((element: any) => element.type === 'shape' && element.id.startsWith('pdf-clip-'));
    expect(clipShape).toBeTruthy();
    expect(clipShape.style).toEqual(expect.objectContaining({
      fill: 'DDEEFF',
      line: '445566',
      lineWidth: 2,
      opacity: 35,
    }));
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'Inside block')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'Outside block')).toBe(false);
  });

  it('can enable full-page image overlay through pdf-to-pptx hints', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Image Page PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/full-page.png', x: 0, y: 0, width: 200, height: 100 },
                  { path: '/tmp/inner.png', x: 50, y: 20, width: 40, height: 20 },
                ],
                elements: [
                  { type: 'clip', x: 10, y: 10, width: 180, height: 70, text: '', fontSize: 0, fontName: '' },
                  { type: 'text', x: 20, y: 18, width: 60, height: 12, text: 'Short', fontSize: 12 },
                  { type: 'heading', x: 20, y: 36, width: 120, height: 18, text: 'Large overlay title', fontSize: 20 },
                ],
                ocrLines: [
                  { id: 'ocr-1', type: 'heading', x: 18, y: 34, width: 120, height: 18, text: 'OCR Overlay Title', fontSize: 20, confidence: 92 },
                ],
              },
            ],
          },
          metadata: { title: 'Image Page PDF', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
            hints: {
              features: {
                fullPageImageOverlay: true,
                fullPageImageOcrOverlay: true,
              },
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => element.id === 'pdf-page-bg-1' && element.imagePath === '/tmp/full-page.png')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'image' && element.imagePath === '/tmp/inner.png')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'shape' && element.id.startsWith('pdf-clip-'))).toBe(false);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'OCR Overlay Title')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'Short')).toBe(false);
  });

  it('runs OCR overlay for full-page image pages when extracted pdf text is mostly unreliable', async () => {
    mocks.recognize.mockResolvedValue({
      data: {
        confidence: 92,
        lines: [
          {
            text: 'OCR Restored Title',
            confidence: 92,
            bbox: { x0: 24, y0: 28, x1: 168, y1: 48 },
          },
        ],
      },
    });

    const unreliableElements = Array.from({ length: 12 }, (_, index) => ({
      type: index === 0 ? 'heading' : 'text',
      x: 20,
      y: 20 + index * 10,
      width: 80,
      height: 10,
      text: index % 2 === 0 ? 'G9GTGBGx' : 'GMG2GmG\u0081G>',
      fontSize: 12,
    }));

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Image OCR PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/full-page.png', x: 0, y: 0, width: 200, height: 100 },
                ],
                elements: unreliableElements,
              },
            ],
          },
          metadata: { title: 'Image OCR PDF', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
            hints: {
              features: {
                fullPageImageOverlay: true,
                fullPageImageOcrOverlay: true,
              },
              ocr: {
                language: 'jpn',
              },
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(mocks.recognize).toHaveBeenCalledWith('/tmp/full-page.png', 'jpn');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'OCR Restored Title')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'G9GTGBGx')).toBe(false);
  });

  it('falls back to OCR text blocks when tesseract returns text without line boxes', async () => {
    mocks.recognize.mockResolvedValue({
      data: {
        confidence: 88,
        text: '最終報告書\nクロスカンパニーメンタリング',
        lines: [],
      },
    });

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Image OCR Text Fallback PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/full-page.png', x: 0, y: 0, width: 200, height: 100 },
                ],
                elements: [],
              },
            ],
          },
          metadata: { title: 'Image OCR Text Fallback PDF', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
            hints: {
              features: {
                fullPageImageOverlay: true,
                fullPageImageOcrOverlay: true,
              },
              ocr: {
                language: 'jpn',
              },
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === '最終報告書')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'クロスカンパニーメンタリング')).toBe(true);
  });

  it('bridges pdf design into xlsx design with merge and style hints', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Seat Chart PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 120,
                height: 60,
                text: '',
                elements: [
                  { type: 'rect', x: 0, y: 0, width: 60, height: 20, fillColor: '#DDEEFF' },
                  { type: 'rect', x: 60, y: 0, width: 30, height: 20, fillColor: '#FFFFFF' },
                  { type: 'rect', x: 90, y: 0, width: 30, height: 20, fillColor: '#FFFFFF' },
                  { type: 'border', x: 0, y: 0, width: 120, height: 1 },
                  { type: 'border', x: 0, y: 20, width: 120, height: 1 },
                  { type: 'border', x: 0, y: 40, width: 120, height: 1 },
                  { type: 'border', x: 0, y: 0, width: 1, height: 40 },
                  { type: 'border', x: 60, y: 0, width: 1, height: 40 },
                  { type: 'border', x: 90, y: 0, width: 1, height: 40 },
                  { type: 'border', x: 120, y: 0, width: 1, height: 40 },
                  { type: 'text', x: 8, y: 8, text: 'Team A', fontSize: 12, color: '#1F2937' },
                  { type: 'text', x: 68, y: 8, text: 'Desk 1', fontSize: 10, color: '#111827' },
                  { type: 'text', x: 98, y: 8, text: 'Desk 2', fontSize: 10, color: '#111827' },
                ],
              },
            ],
          },
          metadata: { title: 'Seat Chart PDF', pageCount: 1 },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_xlsx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_xlsx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const sheet = result.context.last_xlsx_design.sheets[0];
    expect(sheet.mergeCells.length).toBeGreaterThan(0);
    expect(sheet.rows[0].cells.find((cell: any) => cell.ref === 'A1')).toEqual(
      expect.objectContaining({ value: 'Team A' }),
    );
    expect(result.context.last_xlsx_design.styles.cellXfs.length).toBeGreaterThan(1);
  });
});

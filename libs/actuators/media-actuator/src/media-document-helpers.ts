import {
  logger,
  safeReadFile,
  resolveDocumentContentsLabel,
  resolveDocumentContentsSubtitle,
  resolveReportSectionTitle,
  resolveReportSummaryTitle,
  resolveProposalSectionKeywords,
  resolveProposalEvidenceIndex,
  resolveSignalToneRank,
  resolveMediaSemanticType,
  resolveDocumentTypeFromClues as resolveDocumentTypeFromCluesPolicy,
  resolveDocumentProfileCandidates as resolveDocumentProfileCandidatesPolicy,
  resolveDocumentProfileKeywords as resolveDocumentProfileKeywordsPolicy,
  loadMediaSignalEntryPolicyCatalog,
  loadTrackerSheetPolicyCatalog,
  isLegacyMediaOp,
} from '@agent/core';
import * as path from 'node:path';

export type MediaBriefCategory = 'presentation' | 'document' | 'spreadsheet' | 'diagram';
export type ProtocolKind = 'pptx' | 'docx' | 'pdf' | 'xlsx';
export type DocumentCompositionPresetResolver = (rootDir: string, brief: any) => { profileId: string; preset: any };
export type DocumentCompositionCatalogLoader = (rootDir: string) => any;

export function warnLegacyMediaOp(op: string): void {
  if (!isLegacyMediaOp(op)) return;
  logger.warn(
    `[MEDIA_COMPAT] ${op} is a compatibility adapter. Prefer document_outline_from_brief -> brief_to_design_protocol -> generate_document.`,
  );
}

export function buildMediaGenerationBoundary(briefOrOutline: any): any {
  return {
    source_of_truth: {
      document_profile: String(briefOrOutline?.document_profile || ''),
      design_system_id: String(briefOrOutline?.design_system_id || ''),
      knowledge_controls: [
        'document_profile',
        'sections',
        'narrative_pattern_id',
        'layout_key',
        'media_kind',
        'semantic_type',
        'recommended_theme',
      ],
    },
    llm_zone: {
      allowed: [
        'normalize_intent_into_brief',
        'draft_section_objective',
        'draft_body_content',
        'draft_bullets_callouts_tables',
        'localize_operator_facing_text',
      ],
      forbidden: [
        'override_governed_sections',
        'invent_layout_coordinates',
        'invent_semantic_tokens',
        'write_renderer_specific_binary_contracts',
      ],
    },
    compiler_zone: {
      responsibilities: [
        'resolve_profile_and_sections_from_knowledge',
        'map_sections_to_outline',
        'map_outline_to_design_protocol',
        'fill_renderer_defaults_and_guards',
      ],
    },
    renderer_zone: {
      responsibilities: [
        'materialize_pptx_docx_pdf_xlsx_binary',
        'apply_format_specific_low_level_rules',
        'preserve_reproducibility',
      ],
    },
    rule: 'sections-first; document_type is fallback taxonomy; render_target chooses physical renderer last',
  };
}

export function resolveMediaBriefCategory(rawBrief: any): MediaBriefCategory {
  if (!rawBrief || typeof rawBrief !== 'object') {
    throw new Error('resolveMediaBriefCategory: brief must be an object');
  }
  if (rawBrief.kind === 'proposal-brief') return 'presentation';
  const artifactFamily = String(rawBrief.artifact_family || '').trim();
  if (!rawBrief.kind && artifactFamily === 'presentation') return 'presentation';
  if (!rawBrief.kind && artifactFamily === 'document') return 'document';
  if (!rawBrief.kind && artifactFamily === 'spreadsheet') return 'spreadsheet';
  if (!rawBrief.kind && artifactFamily === 'diagram') return 'diagram';
  if (rawBrief.kind !== 'document-brief') {
    throw new Error(`Unsupported brief kind: ${String(rawBrief.kind || 'unknown')}`);
  }
  if (artifactFamily === 'presentation') return 'presentation';
  if (artifactFamily === 'document') return 'document';
  if (artifactFamily === 'spreadsheet') return 'spreadsheet';
  if (artifactFamily === 'diagram') return 'diagram';
  throw new Error(`Unsupported artifact_family in document-brief: ${artifactFamily || 'unknown'}`);
}

export function normalizeBriefForCategory(_rootDir: string, rawBrief: any): any {
  return rawBrief;
}

export function buildCompositionTokenMap(brief: any): Record<string, string> {
  const tokens: Record<string, string> = {};
  const entries = [
    ['title', brief?.title],
    ['objective', brief?.objective],
    ['client', brief?.client],
    ['audience', brief?.audience],
    ['locale', brief?.locale],
  ] as const;
  for (const [key, value] of entries) {
    if (value) tokens[key] = String(value);
  }
  return tokens;
}

export function chooseDocumentSectionEvidence(index: number, brief: any): any {
  const evidence = Array.isArray(brief.evidence || brief.payload?.evidence) ? (brief.evidence || brief.payload?.evidence) : [];
  return evidence[index] || evidence[evidence.length - 1] || null;
}

export function classifyRenderSemantic(layoutKey?: string, mediaKind?: string): string {
  const layout = String(layoutKey || '').toLowerCase();
  const kind = String(mediaKind || '').toLowerCase();
  if (layout.includes('title')) return 'hero';
  if (layout.includes('summary') || layout.includes('overview') || kind === 'summary' || kind === 'dashboard') return 'summary';
  if (layout.includes('execution') || layout.includes('main-table') || kind === 'execution') return 'execution';
  if (layout.includes('contents')) return 'contents';
  if (layout.includes('timeline') || kind === 'roadmap') return 'roadmap';
  if (layout.includes('evidence') || kind === 'evidence') return 'evidence';
  if (layout.includes('decision') || kind === 'cta') return 'decision';
  if (kind === 'signals' || layout.includes('signals')) return 'signals';
  if (kind === 'table' || layout.includes('table')) return 'table';
  if (kind === 'diagram' || layout.includes('diagram')) return 'architecture';
  if (kind === 'appendix') return 'appendix';
  return 'content';
}

export function buildDocumentContentsSection(entries: any[], locale?: string): any | null {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const lines = list.map((entry, index) => {
    const title = String(entry?.title || entry?.heading || entry?.section_id || `Section ${index + 1}`).trim();
    const objective = String(entry?.objective || '').trim();
    return `${index + 1}. ${title}${objective ? ` — ${objective}` : ''}`;
  });
  if (lines.length === 0) return null;
  return {
    section_id: 'contents',
    title: resolveDocumentContentsLabel(locale),
    objective: resolveDocumentContentsSubtitle(),
    body: lines,
    media_kind: 'contents',
    layout_key: 'doc-contents',
    semantic_type: 'summary',
  };
}

export function insertDocumentContentsSection(entries: any[], locale?: string): any[] {
  if (Array.isArray(entries) && entries.some((entry) => String(entry?.section_id || '').trim() === 'contents')) {
    return entries;
  }
  const contentsSection = buildDocumentContentsSection(entries, locale);
  if (!contentsSection) return Array.isArray(entries) ? entries : [];
  const next = Array.isArray(entries) ? [...entries] : [];
  const insertAt = next.length > 0 && ['cover', 'title'].includes(String(next[0]?.section_id || '')) ? 1 : 0;
  next.splice(insertAt, 0, contentsSection);
  return next;
}

export function rankSignalTone(tone?: string): number {
  return resolveSignalToneRank(tone);
}

export function chooseProposalSectionEvidence(sectionId: string, brief: any): any {
  const evidence = Array.isArray(brief.evidence) ? brief.evidence : [];
  const chapters = Array.isArray(brief.story?.chapters) ? brief.story.chapters : [];
  const lowerChapters = chapters.map((entry: string) => String(entry).toLowerCase());
  const keywords = resolveProposalSectionKeywords(sectionId);
  const chapterIndex = lowerChapters.findIndex((chapter) => keywords.some((keyword) => chapter.includes(keyword)));
  if (chapterIndex >= 0 && evidence[chapterIndex]) return evidence[chapterIndex];
  const evidenceIndex = resolveProposalEvidenceIndex(sectionId);
  if (evidenceIndex !== null) return evidence[evidenceIndex] || evidence[0];
  return evidence[0];
}

export function buildReportNarrativeOutline(
  rootDir: string,
  brief: any,
  resolveDocumentCompositionPreset: DocumentCompositionPresetResolver,
  applyCompositionTemplate: (template: any, tokens: Record<string, string>, fallback?: string) => string,
): any {
  const { profileId, preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const payloadSections = Array.isArray(brief.payload?.sections) ? brief.payload.sections : [];
  const presetSections = Array.isArray(preset.sections) ? preset.sections : [];
  const appendixPattern = /\b(appendix|appendices|annex|supplement|reference)\b/i;
  const reportSummaryTitle = resolveReportSummaryTitle();
  const reportSectionTitle = resolveReportSectionTitle();
  const tokens = buildCompositionTokenMap(brief);
  const chapters = Array.isArray(brief.story?.chapters || brief.payload?.story?.chapters)
    ? (brief.story?.chapters || brief.payload?.story?.chapters)
    : [];
  const sections = payloadSections.length > 0
    ? payloadSections.map((section: any) => ({
        section_id: String(section.heading || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title: String(section.heading || reportSectionTitle),
        objective: Array.isArray(section.body) ? String(section.body[0] || '') : '',
        body: [
          ...(Array.isArray(section.body) ? section.body.map((value: any) => String(value)) : []),
          ...(Array.isArray(section.bullets) ? section.bullets.map((value: any) => `- ${String(value)}`) : []),
        ].filter(Boolean),
        visual: Array.isArray(section.callouts) && section.callouts[0]?.title ? String(section.callouts[0].title) : undefined,
        media_kind: appendixPattern.test(String(section.heading || '')) ? 'appendix' : 'section-flow',
        layout_key: appendixPattern.test(String(section.heading || '')) ? 'doc-appendix' : 'doc-sections',
      }))
    : presetSections.map((section: any, index: number) => {
        const evidence = chooseDocumentSectionEvidence(index, brief);
        const chapter = String(chapters[index] || '').trim();
        const objective = applyCompositionTemplate(section.objective, tokens, chapter || brief.objective || section.title || '');
        const body = [
          chapter || objective || brief.objective || '',
          evidence?.point ? String(evidence.point) : '',
        ].filter(Boolean);
        return {
          section_id: String(section.section_id || 'section'),
          title: applyCompositionTemplate(section.title, tokens, section.title || reportSectionTitle),
          objective: objective || chapter || brief.objective || '',
          body,
          visual: evidence?.title ? String(evidence.title) : undefined,
          media_kind: String(section.media_kind || 'section-flow'),
          layout_key: String(section.layout_key || 'doc-sections'),
        };
      });
  const toc = insertDocumentContentsSection(sections, brief.locale);
  return {
    kind: 'document-outline-adf',
    artifact_family: brief.artifact_family,
    document_type: brief.document_type,
    document_profile: profileId,
    design_system_id: preset.design_system_id,
    branding: preset.branding || {},
    prompt_guide: Array.isArray(preset.prompt_guide) ? preset.prompt_guide : [],
    source_design: preset.source_design || null,
    design_recommendations: Array.isArray(preset.design_recommendations) ? preset.design_recommendations : [],
    narrative_pattern_id: preset.narrative_pattern_id || 'report-standard',
    recommended_theme: preset.recommended_theme || 'kyberion-standard',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc: [
      {
        section_id: 'title',
        title: brief.payload?.title || brief.title || 'Report',
        objective: brief.objective || brief.summary || '',
        body: [brief.objective || brief.summary || ''].filter(Boolean),
        visual: brief.title || 'overview',
        media_kind: 'title-page',
        layout_key: 'doc-title',
        semantic_type: classifyRenderSemantic('doc-title', 'title-page'),
      },
      ...((brief.payload?.summary || brief.summary) ? [{
        section_id: 'summary',
        title: reportSummaryTitle,
        objective: brief.payload?.summary || brief.summary || brief.objective || '',
        body: [brief.payload?.summary || brief.summary || brief.objective || ''].filter(Boolean),
        visual: chooseDocumentSectionEvidence(0, brief)?.title || 'summary',
        media_kind: 'summary',
        layout_key: 'doc-summary',
        semantic_type: classifyRenderSemantic('doc-summary', 'summary'),
      }] : []),
      ...toc.map((section: any) => ({
        section_id: String(section.section_id || 'section'),
        title: String(section.title || reportSectionTitle),
        objective: String(section.objective || ''),
        body: Array.isArray(section.body) ? section.body : [section.objective].filter(Boolean),
        visual: section.visual,
        media_kind: String(section.media_kind || 'section-flow'),
        layout_key: String(section.layout_key || 'doc-sections'),
        semantic_type: classifyRenderSemantic(
          String(section.layout_key || 'doc-sections'),
          String(section.media_kind || 'section-flow'),
        ),
      })),
    ],
  };
}

export function buildSpreadsheetNarrativeOutline(rootDir: string, brief: any, resolveDocumentCompositionPreset: DocumentCompositionPresetResolver): any {
  const { profileId, preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const protocol = brief.payload?.protocol;
  const sheetNames = Array.isArray(protocol?.worksheets)
    ? protocol.worksheets.map((sheet: any) => String(sheet?.name || 'Sheet'))
    : [];
  const presetSections = Array.isArray(preset.sections) ? preset.sections : [];
  const sectionIndex = new Map<string, any>(
    presetSections.map((section: any) => [String(section.section_id || ''), section]),
  );
  const signalEntryPolicy = loadMediaSignalEntryPolicyCatalog();
  const trackerSheetPolicy = loadTrackerSheetPolicyCatalog();
  return {
    kind: 'document-outline-adf',
    artifact_family: brief.artifact_family,
    document_type: brief.document_type,
    document_profile: profileId,
    design_system_id: preset.design_system_id,
    branding: preset.branding || {},
    prompt_guide: Array.isArray(preset.prompt_guide) ? preset.prompt_guide : [],
    source_design: preset.source_design || null,
    design_recommendations: Array.isArray(preset.design_recommendations) ? preset.design_recommendations : [],
    narrative_pattern_id: preset.narrative_pattern_id || 'operator-dashboard',
    recommended_theme: preset.recommended_theme || 'kyberion-standard',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc: [
      {
        section_id: 'overview',
        title: sectionIndex.get('overview')?.title || trackerSheetPolicy.sheet_titles.overview,
        media_kind: sectionIndex.get('overview')?.media_kind || 'dashboard',
        layout_key: sectionIndex.get('overview')?.layout_key || 'sheet-overview',
        semantic_type: classifyRenderSemantic(sectionIndex.get('overview')?.layout_key || 'sheet-overview', sectionIndex.get('overview')?.media_kind || 'dashboard'),
      },
      {
        section_id: 'execution-board',
        title: sectionIndex.get('execution-board')?.title || trackerSheetPolicy.sheet_titles.execution_board,
        media_kind: sectionIndex.get('execution-board')?.media_kind || 'table',
        layout_key: sectionIndex.get('execution-board')?.layout_key || 'sheet-main-table',
        semantic_type: classifyRenderSemantic(sectionIndex.get('execution-board')?.layout_key || 'sheet-main-table', sectionIndex.get('execution-board')?.media_kind || 'table'),
      },
      {
        section_id: 'signals',
        title: sectionIndex.get('signals')?.title || signalEntryPolicy.sheet_title,
        media_kind: sectionIndex.get('signals')?.media_kind || 'signals',
        layout_key: sectionIndex.get('signals')?.layout_key || 'sheet-signals',
        semantic_type: classifyRenderSemantic(sectionIndex.get('signals')?.layout_key || 'sheet-signals', sectionIndex.get('signals')?.media_kind || 'signals'),
      },
      ...sheetNames.map((name: string) => ({
        section_id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title: name,
        media_kind: 'table',
        layout_key: 'sheet-main-table',
        semantic_type: classifyRenderSemantic('sheet-main-table', 'table'),
      })),
    ],
  };
}

export function buildDiagramNarrativeOutline(rootDir: string, brief: any, resolveDocumentCompositionPreset: DocumentCompositionPresetResolver): any {
  const { profileId, preset } = resolveDocumentCompositionPreset(rootDir, brief);
  return {
    kind: 'document-outline-adf',
    artifact_family: brief.artifact_family,
    document_type: brief.document_type,
    document_profile: profileId,
    design_system_id: preset.design_system_id,
    branding: preset.branding || {},
    prompt_guide: Array.isArray(preset.prompt_guide) ? preset.prompt_guide : [],
    source_design: preset.source_design || null,
    design_recommendations: Array.isArray(preset.design_recommendations) ? preset.design_recommendations : [],
    narrative_pattern_id: preset.narrative_pattern_id || 'solution-overview',
    recommended_theme: preset.recommended_theme || brief.layout_template_id || 'aws-architecture',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc: [
      {
        section_id: 'system-context',
        title: brief.title || brief.payload?.title || 'Diagram',
        media_kind: 'diagram',
        layout_key: 'diagram-context',
        semantic_type: classifyRenderSemantic('diagram-context', 'diagram'),
      },
    ],
  };
}

export function normalizeInvoiceDocumentBrief(input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Invoice document brief must be an object.');
  }

  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported document brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'document') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (input.document_type !== 'invoice') {
    throw new Error(`Unsupported document_type in document-brief: ${String(input.document_type)}`);
  }
  if (input.render_target !== 'pdf') {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('document-brief for invoice requires an object payload.');
  }

  return {
    ...input.payload,
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'qualified-invoice',
    render_target: input.render_target,
    locale: input.locale || 'ja-JP',
    layout_template_id: input.layout_template_id || input.payload.layout_template_id,
  };
}

export function normalizeDiagramDocumentBrief(input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Diagram document brief must be an object.');
  }

  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported diagram brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'diagram') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (!['mmd', 'd2', 'drawio'].includes(String(input.render_target))) {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('document-brief for diagram requires an object payload.');
  }

  if (input.render_target === 'drawio') {
    if (!input.payload.graph || typeof input.payload.graph !== 'object') {
      throw new Error('document-brief for drawio requires payload.graph.');
    }
  } else if (typeof input.payload.source !== 'string' || !input.payload.source.trim()) {
    throw new Error(`document-brief for ${input.render_target} requires payload.source.`);
  }

  return {
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'solution-overview',
    render_target: input.render_target,
    locale: input.locale || 'en-US',
    layout_template_id: input.layout_template_id,
    title: input.payload.title || input.title,
    payload: input.payload,
  };
}

export function normalizeSpreadsheetDocumentBrief(rootDir: string, input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Spreadsheet document brief must be an object.');
  }
  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported spreadsheet brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'spreadsheet') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (input.render_target !== 'xlsx') {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('document-brief for spreadsheet requires an object payload.');
  }

  let protocol = input.payload.protocol;
  if (!protocol && input.payload.protocol_path) {
    const protocolPath = path.resolve(rootDir, input.payload.protocol_path);
    protocol = JSON.parse(safeReadFile(protocolPath, { encoding: 'utf8' }) as string);
  }
  if (!protocol && (!Array.isArray(input.payload.columns) || !Array.isArray(input.payload.rows))) {
    throw new Error('document-brief for spreadsheet requires payload.protocol, payload.protocol_path, or semantic payload.columns + payload.rows.');
  }

  return {
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'operator-tracker',
    render_target: input.render_target,
    locale: input.locale || 'en-US',
    layout_template_id: input.layout_template_id,
    payload: {
      ...input.payload,
      protocol,
    },
  };
}

export function normalizeReportDocumentBrief(input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Report document brief must be an object.');
  }
  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported report brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'document') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (!['docx', 'pdf', 'pptx'].includes(String(input.render_target))) {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};

  return {
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'summary-report',
    render_target: input.render_target,
    locale: input.locale || 'en-US',
    layout_template_id: input.layout_template_id,
    title: input.title,
    summary: input.summary,
    payload,
  };
}

function gatherDocumentClueText(source: any, data: any): string {
  const pieces: string[] = [];
  const pushValue = (value: any) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (text) pieces.push(text);
  };
  [source?.title, source?.summary, source?.objective, source?.document_type, source?.document_profile, data?.title, data?.summary, data?.objective, data?.document_type, data?.document_profile].forEach(pushValue);
  for (const item of [source?.payload, data?.payload, source, data]) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.sections)) {
      for (const section of item.sections) {
        pushValue(section?.heading);
        pushValue(section?.title);
        pushValue(section?.objective);
        if (Array.isArray(section?.body)) section.body.forEach(pushValue);
        if (Array.isArray(section?.bullets)) section.bullets.forEach(pushValue);
      }
    }
    if (Array.isArray(item.story?.chapters)) item.story.chapters.forEach(pushValue);
    if (Array.isArray(item.items)) {
      for (const entry of item.items) {
        pushValue(entry?.title);
        pushValue(entry?.summary);
        pushValue(entry?.description);
      }
    }
  }
  return pieces.join(' ').toLowerCase();
}

function inferDocumentTypeFromClues(source: any, data: any): string {
  const clueText = gatherDocumentClueText(source, data);
  return resolveDocumentTypeFromCluesPolicy(clueText);
}

function inferDocumentProfileId(
  rootDir: string,
  artifactFamily: string,
  documentType: string,
  source: any,
  data: any,
  loadDocumentCompositionCatalog: DocumentCompositionCatalogLoader,
): string | null {
  const clueText = gatherDocumentClueText(source, data);
  const docType = String(documentType || '').trim();
  const family = String(artifactFamily || '').trim();
  const candidates = resolveDocumentProfileCandidatesPolicy(docType, family);
  const keywords = resolveDocumentProfileKeywordsPolicy(docType, family);
  for (const profileId of candidates) {
    if (keywords.length === 0) return profileId;
    if (keywords.some((keyword) => clueText.includes(keyword))) return profileId;
  }
  if (family && docType) {
    const catalog = loadDocumentCompositionCatalog(rootDir);
    for (const [profileId, profile] of Object.entries(catalog.profiles || {})) {
      if (String((profile as any).artifact_family || '') !== family) continue;
      if (String((profile as any).document_type || '') !== docType) continue;
      return profileId;
    }
  }
  return null;
}

export function buildUnifiedDocumentBrief(
  rootDir: string,
  input: {
    profileId?: string;
    renderTarget?: string;
    source?: any;
    data?: any;
  },
  loadDocumentCompositionCatalog: DocumentCompositionCatalogLoader,
): any {
  const source = (input.source && typeof input.source === 'object') ? input.source : {};
  const data = (input.data && typeof input.data === 'object') ? input.data : {};
  const renderTarget = String(input.renderTarget || source.render_target || data.render_target || '').trim();
  const inferredDocumentType = String(
    source.document_type ||
    data.document_type ||
    inferDocumentTypeFromClues(source, data) ||
    '',
  ).trim();
  const profileId = String(
    input.profileId ||
    source.document_profile ||
    data.document_profile ||
    inferDocumentProfileId(rootDir, source.artifact_family || data.artifact_family || '', inferredDocumentType, source, data, loadDocumentCompositionCatalog) ||
    '',
  ).trim();
  const catalog = loadDocumentCompositionCatalog(rootDir);
  const profilePreset = profileId ? catalog.profiles?.[profileId] || null : null;
  const artifactFamily = String(
    source.artifact_family ||
    data.artifact_family ||
    profilePreset?.artifact_family ||
    (renderTarget === 'pptx' ? 'presentation' : renderTarget === 'xlsx' ? 'spreadsheet' : 'document'),
  ).trim();
  const documentType = String(
    source.document_type ||
    data.document_type ||
    inferredDocumentType ||
    profilePreset?.document_type ||
    (artifactFamily === 'presentation' ? 'proposal' : artifactFamily === 'spreadsheet' ? 'tracker' : 'report'),
  ).trim();

  if (!renderTarget) {
    throw new Error('generate_document requires render_target');
  }
  if (!profileId) {
    throw new Error('generate_document requires profile_id, document_profile, or inferable content');
  }

  if (artifactFamily === 'presentation') {
    const payload = (source.payload && typeof source.payload === 'object')
      ? source.payload
      : (data.payload && typeof data.payload === 'object' ? data.payload : {});
    return {
      kind: 'proposal-brief',
      artifact_family: 'presentation',
      document_type: documentType,
      document_profile: profileId,
      render_target: 'pptx',
      locale: source.locale || data.locale || 'en-US',
      layout_template_id: source.layout_template_id || data.layout_template_id,
      project_id: source.project_id || data.project_id,
      title: source.title || data.title || payload.title || profileId,
      objective: source.objective || data.objective || payload.objective || '',
      client: source.client || data.client || payload.client,
      audience: source.audience || data.audience || payload.audience,
      story: source.story || data.story || payload.story || {},
      evidence: source.evidence || data.evidence || payload.evidence || [],
      required_sections: source.required_sections || data.required_sections || payload.required_sections || [],
      payload,
    };
  }

  if (artifactFamily === 'spreadsheet') {
    return {
      kind: 'document-brief',
      artifact_family: 'spreadsheet',
      document_type: documentType,
      document_profile: profileId,
      render_target: 'xlsx',
      locale: source.locale || data.locale || 'en-US',
      layout_template_id: source.layout_template_id || data.layout_template_id,
      payload: source.payload || data.payload || data,
    };
  }

  return {
    kind: 'document-brief',
    artifact_family: 'document',
    document_type: documentType,
    document_profile: profileId,
    render_target: renderTarget,
    locale: source.locale || data.locale || 'en-US',
    layout_template_id: source.layout_template_id || data.layout_template_id,
    project_id: source.project_id || data.project_id,
    title: source.title || data.title,
    summary: source.summary || data.summary,
    payload: source.payload || data.payload || data,
  };
}

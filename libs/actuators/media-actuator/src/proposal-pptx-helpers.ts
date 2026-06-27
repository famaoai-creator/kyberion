import {
  resolveDocumentContentsLabel,
  resolveDocumentContentsSubtitle,
  resolveMediaSemanticType,
  resolveProposalEvidenceIndex,
  resolveProposalSectionKeywords,
  resolveReportSectionTitle,
  resolveReportSummaryTitle,
  buildSlidePatternDiagnostics,
  selectSlidePattern,
} from '@agent/core';

type ProposalCompositionPresetResolution = {
  profileId: string;
  preset: any;
};

export interface ProposalPptxDependencies {
  resolveDocumentCompositionPreset: (rootDir: string, brief: any) => ProposalCompositionPresetResolution;
  buildMediaGenerationBoundary: (briefOrOutline: any) => any;
}

function buildCompositionTokenMap(brief: any): Record<string, string> {
  return {
    title: String(brief.title || brief.payload?.title || 'Document'),
    client: String(brief.client || brief.payload?.client || ''),
    objective: String(brief.objective || brief.payload?.objective || ''),
    core_message: String(brief.story?.core_message || brief.payload?.story?.core_message || brief.objective || brief.payload?.objective || ''),
    closing_cta: String(brief.story?.closing_cta || brief.payload?.story?.closing_cta || ''),
    audience: Array.isArray(brief.audience || brief.payload?.audience)
      ? (brief.audience || brief.payload?.audience).join(', ')
      : '',
    tone: String(brief.story?.tone || brief.payload?.story?.tone || ''),
  };
}

function applyCompositionTemplate(template: any, tokens: Record<string, string>, fallback = ''): string {
  const source = typeof template === 'string' ? template : fallback;
  return source.replace(/{{\s*([\w-]+)\s*}}/g, (_, key) => tokens[key] || '');
}

function normalizeProposalText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isPlaceholderProposalText(value: unknown): boolean {
  const normalized = normalizeProposalText(value);
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  return [
    /デッキタイトル/,
    /コアメッセージ/,
    /顧客法人名/,
    /スライドタイトル/,
    /箇条書き\d*/,
    /話す内容のメモ/,
    /根拠\d*/,
    /placeholder/,
    /fill me/,
    /todo/,
    /tbd/,
    /client name/,
    /your company/,
    /sample text/,
    /\(\.\.\.が空の場合は内容から生成\)/,
  ].some((pattern) => pattern.test(normalized) || pattern.test(lower));
}

function sanitizeProposalText(value: unknown, fallback: string): string {
  const normalized = normalizeProposalText(value);
  return normalized && !isPlaceholderProposalText(normalized) ? normalized : fallback;
}

function normalizeProposalList(value: unknown, fallback: string[]): string[] {
  const raw = Array.isArray(value) ? value : [];
  const cleaned = raw
    .map((entry) => sanitizeProposalText(entry, ''))
    .filter(Boolean);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : fallback;
}

function normalizeAudienceList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return normalizeProposalList(value, fallback);
  if (typeof value === 'string') {
    const split = value
      .split(/[、,\/・\n]/g)
      .map((entry) => sanitizeProposalText(entry, ''))
      .filter(Boolean);
    return split.length > 0 ? Array.from(new Set(split)) : fallback;
  }
  return fallback;
}

function buildCanonicalProposalEvidence(brief: any): Array<{ title: string; point: string }> {
  const client = sanitizeProposalText(brief.client || brief.payload?.client, '対象組織');
  const objective = sanitizeProposalText(
    brief.objective || brief.payload?.objective,
    `${client}向けの提案を整理する`,
  );
  const coreMessage = sanitizeProposalText(
    brief.story?.core_message || brief.payload?.story?.core_message,
    `${client}に対して、${objective} を governed に実現する提案です。`,
  );

  const provided = normalizeProposalList(
    Array.isArray(brief.evidence) ? brief.evidence.map((entry: any) => ({
      title: entry?.title,
      point: entry?.point,
    })) : [],
    [],
  ).length > 0
    ? (Array.isArray(brief.evidence) ? brief.evidence : [])
        .map((entry: any) => ({
          title: sanitizeProposalText(entry?.title, ''),
          point: sanitizeProposalText(entry?.point, ''),
        }))
        .filter((entry: any) => entry.title && entry.point && !isPlaceholderProposalText(entry.title) && !isPlaceholderProposalText(entry.point))
    : [];

  const defaults = [
    {
      title: 'Current pain points',
      point: `${client}の現状課題を整理し、${objective} の必要性を明確にする。`,
    },
    {
      title: 'Target outcome',
      point: `実現後の運用像と期待効果を可視化し、合意形成を進める。`,
    },
    {
      title: 'Governance design',
      point: `リスク・統制・運用のガードレールを保ったまま実行できる構成にする。`,
    },
    {
      title: 'Delivery plan',
      point: `Discovery / pilot / rollout の段階で確実に前進させる。`,
    },
  ];

  const result = [...provided];
  for (const item of defaults) {
    if (result.length >= 4) break;
    result.push(item);
  }
  if (result.length === 0) {
    result.push({
      title: 'Core message',
      point: coreMessage,
    });
  }
  return result.slice(0, 4);
}

function classifyRenderSemantic(layoutKey?: string, mediaKind?: string): string {
  return resolveMediaSemanticType(layoutKey, mediaKind);
}

function chooseProposalSectionEvidence(sectionId: string, brief: any): any {
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

function buildDocumentContentsSection(entries: any[], locale?: string): any | null {
  const navigable = Array.isArray(entries)
    ? entries.filter((entry) => {
        const sectionId = String(entry?.section_id || '').trim();
        return sectionId && !['contents'].includes(sectionId);
      })
    : [];
  if (navigable.length < 2) return null;
  const reportSectionTitle = resolveReportSectionTitle();
  const body = navigable.map((entry, index) => {
    const title = String(entry?.title || entry?.section_id || `${reportSectionTitle} ${index + 1}`).trim();
    const objective = String(entry?.objective || '').trim();
    return `${index + 1}. ${title}${objective ? ` — ${objective}` : ''}`;
  });
  return {
    section_id: 'contents',
    title: resolveDocumentContentsLabel(locale),
    objective: resolveDocumentContentsSubtitle(),
    body,
    media_kind: 'contents',
    layout_key: 'doc-contents',
    semantic_type: 'summary',
  };
}

function insertDocumentContentsSection(entries: any[], locale?: string): any[] {
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

function resolveBriefDeckPurpose(brief: any): string {
  return String(brief.deck_purpose || brief.payload?.deck_purpose || 'proposal');
}

function resolveSlidePatternSelectionPolicy(brief: any): any | undefined {
  const explicitPolicy =
    brief.slide_pattern_selection_policy ||
    brief.payload?.slide_pattern_selection_policy ||
    brief.slide_pattern_selection;
  if (explicitPolicy && typeof explicitPolicy === 'object') return explicitPolicy;

  const requestedPatternId = String(brief.slide_pattern_id || brief.payload?.slide_pattern_id || '').trim();
  const requestedPackId = String(brief.slide_pattern_pack_id || brief.payload?.slide_pattern_pack_id || '').trim();
  if (!requestedPatternId && !requestedPackId) return undefined;
  return {
    pack_id: requestedPackId || 'slide-md-core',
    default_pattern_id: requestedPatternId || undefined,
  };
}

function classifySlidePatternSemantic(section: any, entry: any): string {
  const sectionId = String(section?.section_id || entry?.section_id || '').toLowerCase();
  const candidates: Record<string, string> = {
    cover: 'hero',
    contents: 'summary',
    'executive-summary': 'summary',
    'why-change': 'problem',
    'target-outcome': 'solution',
    'solution-shape': 'architecture',
    recommendation: 'solution',
    plan: 'plan',
    governance: 'roi',
    'delivery-plan': 'roadmap',
    decision: 'cta',
  };
  return candidates[sectionId] || String(entry?.semantic_type || '').trim() || classifyRenderSemantic(entry?.layout_key, entry?.media_kind);
}

function applySlidePatternSelection(entry: any, brief: any, section: any = entry): any {
  const semanticType = classifySlidePatternSemantic(section, entry);
  const selection = selectSlidePattern({
    deckPurpose: resolveBriefDeckPurpose(brief),
    semanticType,
    slideType: entry.media_kind,
    layoutKey: entry.layout_key,
    policy: resolveSlidePatternSelectionPolicy(brief),
  });
  if (!selection) return entry;

  const currentLayoutKey = String(entry.layout_key || '').trim();
  const canUsePatternLayout = !currentLayoutKey || ['title-body', 'doc-contents'].includes(currentLayoutKey);
  return {
    ...entry,
    semantic_type: semanticType,
    pattern_id: selection.pattern_id,
    slide_pattern: selection,
    layout_key: canUsePatternLayout ? selection.layout_key : entry.layout_key,
    media_kind: entry.media_kind || selection.media_kind,
    body_zone: selection.body_zone,
  };
}

function buildCanonicalProposalSlides(deps: ProposalPptxDependencies, rootDir: string, brief: any): any[] {
  const { preset } = deps.resolveDocumentCompositionPreset(rootDir, brief);
  const sections = Array.isArray(preset.sections) ? preset.sections : [];
  const evidence = buildCanonicalProposalEvidence(brief);
  const storyChapters = normalizeProposalList(
    brief.story?.chapters || brief.payload?.story?.chapters,
    sections
      .filter((section: any) => !['cover', 'contents'].includes(String(section.section_id || '')))
      .map((section: any) => String(section.title || section.section_id || '').trim())
      .filter(Boolean),
  );
  const audience = normalizeAudienceList(
    brief.audience || brief.payload?.audience,
    ['Executive Sponsor'],
  );
  const client = sanitizeProposalText(brief.client || brief.payload?.client, '対象組織');
  const objective = sanitizeProposalText(
    brief.objective || brief.payload?.objective,
    `${client}向けの提案を整理する`,
  );
  const coreMessage = sanitizeProposalText(
    brief.story?.core_message || brief.payload?.story?.core_message,
    `${client}に対して、${objective} を governed に実現する提案です。`,
  );
  const closingCta = sanitizeProposalText(
    brief.story?.closing_cta || brief.payload?.story?.closing_cta,
    'Approve the discovery and pilot phase.',
  );
  const rawSlides = Array.isArray(brief.slides) ? brief.slides : [];
  const slideByKey = new Map<string, any>();
  for (const slide of rawSlides) {
    const keys = [
      sanitizeProposalText(slide?.id || slide?.section_id, ''),
      sanitizeProposalText(slide?.semantic_type, ''),
    ].filter(Boolean);
    for (const key of keys) slideByKey.set(key, slide);
  }

  const fallbackBodies: Record<string, string[]> = {
    cover: [coreMessage],
    'executive-summary': [
      coreMessage,
      `Audience: ${audience.join(', ')}`,
      `Objective: ${objective}`,
    ],
    'why-change': [
      evidence[0]?.point,
      `現状を変えない場合のコストとリスクを明確化する。`,
    ],
    'target-outcome': [
      evidence[1]?.point,
      `期待効果と運用上の成功条件を定義する。`,
    ],
    'solution-shape': [
      evidence[2]?.point,
      `推奨アプローチと差別化要素を端的に示す。`,
    ],
    governance: [
      evidence[2]?.point,
      `監査・権限・運用ルールを組み込んで安全に実行する。`,
    ],
    'delivery-plan': [
      evidence[3]?.point,
      `Discovery → pilot → rollout の段階で進める。`,
    ],
    decision: [
      closingCta,
      `Owner: ${audience[0] || 'Executive Sponsor'}`,
    ],
  };

  const slideDefs = sections
    .filter((section: any) => String(section.section_id || '') !== 'contents')
    .map((section: any, index: number) => {
      const sectionId = String(section.section_id || `slide-${index + 1}`);
      const canonicalSlide = slideByKey.get(sectionId) || slideByKey.get(String(section.media_kind || '')) || null;
      const titleFallback = sectionId === 'cover'
        ? sanitizeProposalText(brief.title || brief.payload?.title || section.title, sectionId)
        : sanitizeProposalText(section.title, sectionId);
      const objectiveFallback = sanitizeProposalText(section.objective, '');
      const fallbackBody = fallbackBodies[sectionId] || [
        objectiveFallback || objective,
        evidence[index % evidence.length]?.point,
      ].filter(Boolean);
      const providedBody = Array.isArray(canonicalSlide?.body)
        ? canonicalSlide.body.map((entry: any) => sanitizeProposalText(entry, '')).filter(Boolean)
        : [];
      const providedTitle = sanitizeProposalText(canonicalSlide?.title, '');
      const title = providedTitle || titleFallback;
      const body = providedBody.length > 0 ? providedBody : fallbackBody;
      return applySlidePatternSelection({
        id: sectionId,
        semantic_type: sanitizeProposalText(canonicalSlide?.semantic_type, section.media_kind || 'content'),
        title,
        body,
        visual: sanitizeProposalText(canonicalSlide?.visual, section.visual || 'supporting visual'),
        speaker_notes: sanitizeProposalText(canonicalSlide?.speaker_notes, objectiveFallback || objective),
      }, brief, section);
    });

  return slideDefs;
}

function buildProposalNarrativeOutline(deps: ProposalPptxDependencies, rootDir: string, brief: any): any {
  const { profileId, preset } = deps.resolveDocumentCompositionPreset(rootDir, brief);
  const tokens = buildCompositionTokenMap(brief);
  const sections = Array.isArray(preset.sections) ? preset.sections : [];
  const requestedSections = Array.isArray(brief.required_sections) ? new Set(brief.required_sections.map((value: any) => String(value))) : null;
  const toc = insertDocumentContentsSection(sections
    .filter((section: any) => !requestedSections || requestedSections.size === 0 || requestedSections.has(section.section_id) || ['cover', 'decision'].includes(section.section_id))
    .map((section: any, index: number) => {
      const supporting = chooseProposalSectionEvidence(section.section_id, brief) || {};
      const chapter = Array.isArray(brief.story?.chapters) ? brief.story.chapters[index] : undefined;
      return applySlidePatternSelection({
        section_id: section.section_id,
        title: applyCompositionTemplate(section.title, tokens, chapter || section.section_id),
        objective: applyCompositionTemplate(section.objective, tokens, chapter || brief.objective || ''),
        body: [
          supporting.point || chapter || brief.story?.core_message || brief.objective,
          section.section_id === 'executive-summary' && tokens.audience ? `Audience: ${tokens.audience}` : undefined,
          section.section_id === 'decision' && tokens.tone ? `Tone: ${tokens.tone}` : undefined,
        ].filter(Boolean),
        visual: supporting.title || section.visual || 'supporting visual',
        media_kind: section.media_kind || 'content',
        layout_key: section.layout_key || 'title-body',
        semantic_type: classifyRenderSemantic(section.layout_key, section.media_kind),
      }, brief, section);
    }), brief.locale);

  for (const entry of toc) {
    if (!entry.pattern_id) {
      Object.assign(entry, applySlidePatternSelection(entry, brief));
    }
  }

  const resolvedProposalTitle = sanitizeProposalText(brief.title || brief.payload?.title, '');
  const resolvedCoreMessage = sanitizeProposalText(
    brief.story?.core_message || brief.payload?.story?.core_message,
    '',
  );
  const coverEntry = toc.find((entry: any) => String(entry.section_id || '') === 'cover');
  if (coverEntry) {
    if (resolvedProposalTitle) coverEntry.title = resolvedProposalTitle;
    if (resolvedCoreMessage) {
      coverEntry.objective = resolvedCoreMessage;
      coverEntry.body = [resolvedCoreMessage];
    }
  }
  const contentsEntry = toc.find((entry: any) => String(entry.section_id || '') === 'contents');
  if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0 && resolvedProposalTitle) {
    contentsEntry.body = contentsEntry.body.map((line: string, idx: number) => {
      if (idx !== 0) return line;
      return line.replace(/^1\.\s*[^—]+—/, `1. ${resolvedProposalTitle} —`);
    });
  }

  if (Array.isArray(brief.slides) && brief.slides.length > 0) {
    const SECTION_SEMANTIC_CANDIDATES: Record<string, string[]> = {
      'cover':            ['hero'],
      'executive-summary':['summary'],
      'why-change':       ['problem'],
      'target-outcome':   ['solution'],
      'solution-shape':   ['solution', 'architecture', 'plan'],
      'governance':       ['roi', 'control'],
      'delivery-plan':    ['roadmap', 'plan'],
      'decision':         ['cta', 'decision'],
    };
    const usedSlideIds = new Set<string>();
    toc.forEach((entry: any) => {
      const candidates = SECTION_SEMANTIC_CANDIDATES[entry.section_id] || [entry.section_id];
      for (const semanticType of candidates) {
        const match = brief.slides.find((s: any) => {
          const st = String(s.semantic_type || '').toLowerCase();
          const sid = String(s.id || s.section_id || st);
          return st === semanticType && !usedSlideIds.has(sid);
        });
        if (match) {
          const matchId = String(match.id || match.section_id || match.semantic_type);
          usedSlideIds.add(matchId);
          if (Array.isArray(match.body) && match.body.length > 0) entry.body = match.body;
          if (match.title && typeof match.title === 'string') entry.title = match.title;
          Object.assign(entry, applySlidePatternSelection(entry, brief));
          break;
        }
      }
    });
  }

  const diagnostics = buildSlidePatternDiagnostics(toc as Array<Record<string, unknown>>);

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
    narrative_pattern_id: preset.narrative_pattern_id || 'generic-structured',
    recommended_theme: brief.theme || brief.payload?.theme || preset.recommended_theme || 'kyberion-standard',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: deps.buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc,
    diagnostics,
  };
}

function normalizeProposalBrief(deps: ProposalPptxDependencies, rootDir: string, input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Proposal brief must be an object.');
  }

  const base = input.kind === 'document-brief'
    ? {
        ...input.payload,
        ...input,
      }
    : { ...input };

  if (base.kind === 'document-brief') {
    if (base.artifact_family !== 'presentation') {
      throw new Error(`Unsupported artifact_family in document-brief: ${String(base.artifact_family)}`);
    }
    if (base.document_type !== 'proposal') {
      throw new Error(`Unsupported document_type in document-brief: ${String(base.document_type)}`);
    }
    if (base.render_target !== 'pptx') {
      throw new Error(`Unsupported render_target in document-brief: ${String(base.render_target)}`);
    }
    if (!base.payload || typeof base.payload !== 'object') {
      throw new Error('document-brief for proposal requires an object payload.');
    }
  }

  if (base.kind === 'proposal-brief' || (base.artifact_family === 'presentation' && base.document_type === 'proposal')) {
    const defaultProfile = base.document_profile || 'executive-proposal';
    const preset = deps.resolveDocumentCompositionPreset(rootDir, {
      artifact_family: 'presentation',
      document_type: 'proposal',
      document_profile: defaultProfile,
      layout_template_id: base.layout_template_id,
      project_id: base.project_id || base.payload?.project_id,
      project_name: base.project_name || base.payload?.project_name,
      tenant_id: base.tenant_id || base.payload?.tenant_id,
      client_key: base.client_key || base.payload?.client_key,
      design_system_id: base.design_system_id || base.payload?.design_system_id,
      design_reference: base.design_reference || base.payload?.design_reference,
      theme: base.theme || base.payload?.theme,
      branding: base.branding || base.payload?.branding,
      title: base.title || base.payload?.title,
      client: base.client || base.payload?.client,
      objective: base.objective || base.payload?.objective,
      audience: base.audience || base.payload?.audience,
      story: base.story || base.payload?.story,
      evidence: base.evidence || base.payload?.evidence,
    }).preset;
    const normalized = {
      artifact_family: 'presentation',
      document_type: 'proposal',
      document_profile: defaultProfile,
      render_target: base.render_target || 'pptx',
      locale: base.locale || 'en-US',
      layout_template_id: base.layout_template_id || base.payload?.layout_template_id || preset.recommended_layout_template_id,
      ...base,
    };
    const title = sanitizeProposalText(normalized.title || normalized.payload?.title, '');
    const client = sanitizeProposalText(normalized.client || normalized.payload?.client, '');
    const objective = sanitizeProposalText(normalized.objective || normalized.payload?.objective, '');
    const coreMessage = sanitizeProposalText(normalized.story?.core_message || normalized.payload?.story?.core_message, '');
    const slides = buildCanonicalProposalSlides(deps, rootDir, normalized);
    const evidence = buildCanonicalProposalEvidence(normalized);
    const canonicalSections = Array.isArray(preset.sections) ? preset.sections : [];
    const requiredSections = canonicalSections.map((section: any) => String(section.section_id || '')).filter(Boolean);
    const audience = normalizeAudienceList(normalized.audience || normalized.payload?.audience, ['Executive Sponsor']);
    const storyChapters = normalizeProposalList(
      normalized.story?.chapters || normalized.payload?.story?.chapters,
      canonicalSections
        .filter((section: any) => !['cover', 'contents'].includes(String(section.section_id || '')))
        .map((section: any) => String(section.title || section.section_id || '').trim())
        .filter(Boolean),
    );

    return {
      kind: 'proposal-brief',
      artifact_family: 'presentation',
      document_type: 'proposal',
      document_profile: defaultProfile,
      render_target: 'pptx',
      locale: normalized.locale,
      layout_template_id: normalized.layout_template_id,
      project_id: normalized.project_id || normalized.payload?.project_id,
      project_name: normalized.project_name || normalized.payload?.project_name,
      tenant_id: normalized.tenant_id || normalized.payload?.tenant_id,
      client_key: normalized.client_key || normalized.payload?.client_key,
      design_system_id: normalized.design_system_id || normalized.payload?.design_system_id,
      design_reference: normalized.design_reference || normalized.payload?.design_reference,
      theme: normalized.theme || normalized.payload?.theme,
      deck_purpose: normalized.deck_purpose || normalized.payload?.deck_purpose,
      slide_pattern_id: normalized.slide_pattern_id || normalized.payload?.slide_pattern_id,
      slide_pattern_pack_id: normalized.slide_pattern_pack_id || normalized.payload?.slide_pattern_pack_id,
      slide_pattern_selection_policy:
        normalized.slide_pattern_selection_policy ||
        normalized.payload?.slide_pattern_selection_policy ||
        normalized.slide_pattern_selection ||
        normalized.payload?.slide_pattern_selection,
      branding: normalized.branding || normalized.payload?.branding || {},
      title: title || client || objective || canonicalSections?.[0]?.title || 'Proposal',
      client: client || '対象組織',
      objective: objective || `${client || '対象組織'}向けの提案を整理する`,
      audience,
      story: {
        core_message: coreMessage || `${client || '対象組織'}に対して、${objective || '提案の内容'} を governed に実現する提案です。`,
        chapters: storyChapters,
        tone: sanitizeProposalText(normalized.story?.tone || normalized.payload?.story?.tone, 'executive and evidence-based'),
        closing_cta: sanitizeProposalText(normalized.story?.closing_cta || normalized.payload?.story?.closing_cta, 'Approve the discovery and pilot phase.'),
      },
      evidence,
      required_sections: requiredSections,
      slides,
    };
  }

  throw new Error(`Unsupported proposal brief kind: ${String(base.kind || 'unknown')}`);
}

export function createProposalPptxFlow(deps: ProposalPptxDependencies) {
  return {
    buildCompositionTokenMap,
    applyCompositionTemplate,
    normalizeProposalText,
    isPlaceholderProposalText,
    sanitizeProposalText,
    normalizeProposalList,
    normalizeAudienceList,
    buildCanonicalProposalEvidence,
    buildCanonicalProposalSlides: (rootDir: string, brief: any) => buildCanonicalProposalSlides(deps, rootDir, brief),
    buildProposalNarrativeOutline: (rootDir: string, brief: any) => buildProposalNarrativeOutline(deps, rootDir, brief),
    normalizeProposalBrief: (rootDir: string, input: any) => normalizeProposalBrief(deps, rootDir, input),
  };
}

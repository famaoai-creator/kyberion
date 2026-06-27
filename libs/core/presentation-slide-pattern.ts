import { pathResolver } from './path-resolver.js';
import type { PresentationDeckPurpose } from './presentation-preference-profile.js';
import { safeReadFile } from './secure-io.js';

export interface SlidePatternSlot {
  slot_id: string;
  role: string;
  required: boolean;
  min_items?: number;
  max_items?: number;
  max_chars_per_item?: number;
  notes?: string;
}

export interface SlidePatternConstraint {
  kind: 'paired_item_counts_match' | 'requires_visual' | 'single_message';
  slots?: string[];
  message?: string;
}

export interface SlidePatternRendererHints {
  layout_key: string;
  body_zone: string;
  media_kind?: string;
  visual_treatment?: string;
  fallback_pattern_id?: string;
}

export interface SlidePatternDefinition {
  pattern_id: string;
  category: string;
  summary: string;
  suitable_scenes: string[];
  slide_types: string[];
  semantic_types: string[];
  deck_purposes?: PresentationDeckPurpose[];
  structure: Record<string, unknown> & { layout: string };
  element_slots: SlidePatternSlot[];
  constraints?: SlidePatternConstraint[];
  renderer_hints: SlidePatternRendererHints;
}

export interface SlidePatternPack {
  kind: 'slide-pattern-pack';
  version: string;
  pack_id: string;
  source: {
    name: string;
    repository?: string;
    revision?: string;
    notes?: string;
  };
  patterns: SlidePatternDefinition[];
}

export interface PresentationSlidePatternSelectionRule {
  semantic_type?: string;
  slide_type?: string;
  deck_purpose?: PresentationDeckPurpose;
  pattern_id: string;
}

export interface PresentationSlidePatternSelectionPolicy {
  pack_id?: string;
  default_pattern_id?: string;
  rules?: PresentationSlidePatternSelectionRule[];
}

export interface SelectSlidePatternInput {
  deckPurpose?: string | null;
  semanticType?: string | null;
  slideType?: string | null;
  layoutKey?: string | null;
  policy?: PresentationSlidePatternSelectionPolicy | null;
  pack?: SlidePatternPack;
}

export interface SlidePatternSelection {
  pattern_id: string;
  category: string;
  layout_key: string;
  media_kind?: string;
  body_zone: string;
  constraints: SlidePatternConstraint[];
  element_slots: SlidePatternSlot[];
  source: {
    pack_id: string;
    reason: string;
  };
}

export interface SlidePatternDiagnostic {
  level: 'info' | 'warn';
  code: string;
  message: string;
  slide_id?: string;
  pattern_id?: string;
}

const DEFAULT_PACK_PATH = 'knowledge/public/design-patterns/presentation/slide-pattern-pack.json';
const GENERIC_LAYOUT_KEYS = new Set(['title-body', 'doc-contents']);
const COMPARISON_PATTERN_IDS = new Set([
  'problem-solution',
  'before-after-two-col',
  'comparison-table-with-highlight',
]);
const ROADMAP_PATTERN_IDS = new Set(['four-step-flow', 'milestone-timeline']);

let cachedPack: SlidePatternPack | null = null;

function normalize(value?: string | null): string {
  return String(value || '').trim().toLowerCase();
}

function isGenericLayoutKey(layoutKey?: string | null): boolean {
  return GENERIC_LAYOUT_KEYS.has(normalize(layoutKey));
}

function loadPackFromPath(packPath: string): SlidePatternPack {
  return JSON.parse(safeReadFile(packPath, { encoding: 'utf8' }) as string) as SlidePatternPack;
}

export function resetSlidePatternPackCache(): void {
  cachedPack = null;
}

export function loadSlidePatternPack(packPath?: string): SlidePatternPack {
  const resolvedPath = packPath || pathResolver.rootResolve(DEFAULT_PACK_PATH);
  if (!packPath && cachedPack) return cachedPack;
  const pack = loadPackFromPath(resolvedPath);
  if (!packPath) cachedPack = pack;
  return pack;
}

function scorePattern(
  pattern: SlidePatternDefinition,
  input: SelectSlidePatternInput,
): { score: number; reason: string; genericLayout: boolean } {
  const deckPurpose = normalize(input.deckPurpose);
  const semanticType = normalize(input.semanticType);
  const slideType = normalize(input.slideType);
  const layoutKey = normalize(input.layoutKey);
  let score = 0;
  const reasons: string[] = [];
  const genericLayout = isGenericLayoutKey(pattern.renderer_hints.layout_key);

  if (semanticType && pattern.semantic_types.map(normalize).includes(semanticType)) {
    score += 8;
    reasons.push(`semantic_type:${semanticType}`);
  }
  if (slideType && pattern.slide_types.map(normalize).includes(slideType)) {
    score += 5;
    reasons.push(`slide_type:${slideType}`);
  }
  if (layoutKey && normalize(pattern.renderer_hints.layout_key) === layoutKey) {
    if (genericLayout) {
      score -= 2;
      reasons.push(`generic_layout_match:${layoutKey}`);
    } else {
      score += 4;
      reasons.push(`layout_key:${layoutKey}`);
    }
  }
  if (deckPurpose && pattern.deck_purposes?.map(normalize).includes(deckPurpose)) {
    score += 2;
    reasons.push(`deck_purpose:${deckPurpose}`);
  }
  if (genericLayout) {
    score -= 1;
    reasons.push(`generic_layout:${pattern.renderer_hints.layout_key}`);
  }

  return { score, reason: reasons.join(',') || 'fallback', genericLayout };
}

function patternToSelection(
  pattern: SlidePatternDefinition,
  pack: SlidePatternPack,
  reason: string,
): SlidePatternSelection {
  return {
    pattern_id: pattern.pattern_id,
    category: pattern.category,
    layout_key: pattern.renderer_hints.layout_key,
    media_kind: pattern.renderer_hints.media_kind,
    body_zone: pattern.renderer_hints.body_zone,
    constraints: pattern.constraints || [],
    element_slots: pattern.element_slots,
    source: {
      pack_id: pack.pack_id,
      reason,
    },
  };
}

export function selectSlidePattern(input: SelectSlidePatternInput): SlidePatternSelection | null {
  const pack = input.pack || loadSlidePatternPack();
  const patterns = Array.isArray(pack.patterns) ? pack.patterns : [];
  if (patterns.length === 0) return null;

  const rules = input.policy?.rules || [];
  const deckPurpose = normalize(input.deckPurpose);
  const semanticType = normalize(input.semanticType);
  const slideType = normalize(input.slideType);
  const matchedRule = rules.find((rule) => {
    if (rule.deck_purpose && normalize(rule.deck_purpose) !== deckPurpose) return false;
    if (rule.semantic_type && normalize(rule.semantic_type) !== semanticType) return false;
    if (rule.slide_type && normalize(rule.slide_type) !== slideType) return false;
    return true;
  });
  if (matchedRule) {
    const pattern = patterns.find((entry) => entry.pattern_id === matchedRule.pattern_id);
    if (pattern) return patternToSelection(pattern, pack, 'policy-rule');
  }

  const scored = patterns
    .map((pattern) => ({ pattern, ...scorePattern(pattern, input) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      Number(a.genericLayout) - Number(b.genericLayout) ||
      a.pattern.pattern_id.localeCompare(b.pattern.pattern_id)
    );
  if (scored[0]) return patternToSelection(scored[0].pattern, pack, scored[0].reason);

  const fallbackId = input.policy?.default_pattern_id || 'key-message-single';
  const fallback = patterns.find((entry) => entry.pattern_id === fallbackId) || patterns[0];
  return patternToSelection(fallback, pack, 'default');
}

function extractSlidePatternContent(slide: Record<string, unknown>): Record<string, unknown> {
  const body = Array.isArray(slide.body)
    ? slide.body.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const title = String(slide.title || '').trim();
  const objective = String(slide.objective || '').trim();
  const splitIndex = Math.max(1, Math.ceil(body.length / 2));
  return {
    title,
    subtitle: objective,
    message: title,
    support: body[0] || objective,
    agenda_items: body,
    takeaways: body,
    actions: body,
    steps: body,
    milestones: body,
    cards: body,
    comparison_rows: body,
    kpis: body,
    problem_items: body.slice(0, splitIndex),
    solution_items: body.slice(splitIndex),
    before_items: body.slice(0, splitIndex),
    after_items: body.slice(splitIndex),
    section_title: title,
    section_subtitle: objective,
  };
}

function appendDiagnostic(
  diagnostics: SlidePatternDiagnostic[],
  diagnostic: SlidePatternDiagnostic,
  limit = 8,
): void {
  if (diagnostics.length >= limit) return;
  diagnostics.push(diagnostic);
}

export function buildSlidePatternDiagnostics(
  slides: Array<Record<string, unknown>>,
): SlidePatternDiagnostic[] {
  const diagnostics: SlidePatternDiagnostic[] = [];
  const list = Array.isArray(slides) ? slides : [];
  let genericLayoutCount = 0;
  let hasComparisonPattern = false;
  let hasRoadmapPattern = false;

  for (const slide of list) {
    const slideId = String(slide.id || slide.section_id || '').trim();
    const selection = slide.slide_pattern as SlidePatternSelection | undefined;
    const layoutKey = String(slide.layout_key || selection?.layout_key || '').trim();
    const patternId = String(slide.pattern_id || selection?.pattern_id || '').trim();

    if (isGenericLayoutKey(layoutKey)) {
      genericLayoutCount += 1;
    }

    const title = String(slide.title || '').trim();
    if (title.length > 54) {
      appendDiagnostic(diagnostics, {
        level: 'warn',
        code: 'headline-too-long',
        message: `${slideId || 'slide'} has a headline that is too long.`,
        slide_id: slideId || undefined,
        pattern_id: patternId || undefined,
      });
    }

    if (selection) {
      if (COMPARISON_PATTERN_IDS.has(selection.pattern_id)) {
        hasComparisonPattern = true;
      }
      if (ROADMAP_PATTERN_IDS.has(selection.pattern_id)) {
        hasRoadmapPattern = true;
      }
      const warnings = validateSlidePatternContent(selection, extractSlidePatternContent(slide));
      for (const warning of warnings) {
        appendDiagnostic(diagnostics, {
          level: 'warn',
          code: 'pattern-validation',
          message: warning,
          slide_id: slideId || undefined,
          pattern_id: selection.pattern_id,
        });
      }
    }
  }

  if (genericLayoutCount > 0) {
    diagnostics.unshift({
      level: 'warn',
      code: 'generic-layouts',
      message: `${genericLayoutCount} slide(s) still use a generic title-body/doc-contents layout.`,
    });
  }

  if (hasComparisonPattern && hasRoadmapPattern) {
    appendDiagnostic(diagnostics, {
      level: 'info',
      code: 'mixed-story-families',
      message: 'Comparison and roadmap patterns are mixed in the same deck.',
    });
  }

  return diagnostics;
}

export function applySlidePatternToSection(
  section: Record<string, unknown>,
  input: SelectSlidePatternInput = {},
): Record<string, unknown> {
  const selection = selectSlidePattern({
    ...input,
    semanticType: input.semanticType ?? String(section.semantic_type || ''),
    slideType: input.slideType ?? String(section.media_kind || section.slide_type || ''),
    layoutKey: input.layoutKey ?? String(section.layout_key || ''),
  });
  if (!selection) return section;
  return {
    ...section,
    pattern_id: selection.pattern_id,
    slide_pattern: selection,
    layout_key: section.layout_key || selection.layout_key,
    media_kind: section.media_kind || selection.media_kind,
  };
}

export function validateSlidePatternContent(
  selection: SlidePatternSelection,
  content: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  for (const slot of selection.element_slots) {
    const value = content[slot.slot_id];
    const values = Array.isArray(value) ? value.map(String).filter(Boolean) : value ? [String(value)] : [];
    if (slot.required && values.length === 0) {
      warnings.push(`${slot.slot_id} is required for ${selection.pattern_id}.`);
    }
    if (slot.min_items && values.length > 0 && values.length < slot.min_items) {
      warnings.push(`${slot.slot_id} expects at least ${slot.min_items} item(s).`);
    }
    if (slot.max_items && values.length > slot.max_items) {
      warnings.push(`${slot.slot_id} expects at most ${slot.max_items} item(s).`);
    }
    if (slot.max_chars_per_item) {
      for (const item of values) {
        if (item.length > slot.max_chars_per_item) {
          warnings.push(`${slot.slot_id} item exceeds ${slot.max_chars_per_item} characters.`);
          break;
        }
      }
    }
  }
  for (const constraint of selection.constraints) {
    if (constraint.kind !== 'paired_item_counts_match' || !constraint.slots || constraint.slots.length < 2) {
      continue;
    }
    const counts = constraint.slots.map((slot) => {
      const value = content[slot];
      return Array.isArray(value) ? value.length : value ? 1 : 0;
    });
    if (new Set(counts).size > 1) {
      warnings.push(constraint.message || `${constraint.slots.join(', ')} item counts must match.`);
    }
  }
  return warnings;
}

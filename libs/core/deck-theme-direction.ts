import { createLogger } from './logger.js';
import { tryRepairJson } from './json-repair.js';

// Deck counterpart of video-visual-direction (agy/media design quality):
// documents and decks always fell back to the preset default theme
// (kyberion-standard) unless the brief explicitly named one — the story
// never influenced the look. Decks are safer than video here: the LLM only
// SELECTS from the governed themes.json catalog; anything outside the
// catalog degrades to the default, so a render can never pick up an
// ungoverned palette.

const logger = createLogger('deck-theme-direction');

export interface DeckThemeCatalogEntry {
  id: string;
  name?: string;
  description?: string;
}

export interface SelectDeckThemeInput {
  title: string;
  summary: string;
  tone?: string;
  audience?: string;
  catalog: DeckThemeCatalogEntry[];
  defaultTheme: string;
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
}

export async function selectDeckTheme(input: SelectDeckThemeInput): Promise<string> {
  if (input.catalog.length === 0) return input.defaultTheme;
  const prompt = [
    'You are an art director choosing a slide theme for a document/deck.',
    `Title: ${input.title}`,
    input.tone ? `Tone: ${input.tone}` : '',
    input.audience ? `Audience: ${input.audience}` : '',
    `Story summary: ${input.summary.slice(0, 1500)}`,
    '',
    'Available themes (pick exactly one id from this list):',
    ...input.catalog.map(
      (entry) =>
        `- ${entry.id}${entry.name ? ` (${entry.name})` : ''}${entry.description ? `: ${entry.description}` : ''}`
    ),
    '',
    'Reply with ONLY a JSON object: { "theme_id": string, "reason": string }',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const generate =
      input.generate ??
      (async (p: string) => {
        const { getReasoningBackend } = await import('./reasoning-backend.js');
        return String(await getReasoningBackend().prompt(p));
      });
    const raw = await generate(prompt);
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    const choice = String(parsed?.theme_id ?? '').trim();
    if (input.catalog.some((entry) => entry.id === choice)) {
      return choice;
    }
    logger.warn(
      `selected theme "${choice}" is not in the catalog — using default ${input.defaultTheme}`
    );
    return input.defaultTheme;
  } catch (error: any) {
    logger.warn(`deck theme selection failed, using default: ${error?.message || error}`);
    return input.defaultTheme;
  }
}

export interface DeckSectionDraftInput {
  title: string;
  tone?: string;
  audience?: string;
  locale?: string;
  sections: Array<{ id: string; title: string; body?: string }>;
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
}

/**
 * LLM-boundary audit fix B (minimal viable draft_body_content): fill ONLY
 * the sections whose body is empty. The llm_zone declaration promised this
 * for a year with no implementation — briefs without body text rendered as
 * thin heading-only decks. Sections that already carry a body are never
 * touched (operator/brief content wins); any failure keeps the outline
 * unchanged.
 */
export async function draftDeckSectionBodies(
  input: DeckSectionDraftInput
): Promise<Record<string, string>> {
  const empty = input.sections.filter((section) => !String(section.body ?? '').trim());
  if (empty.length === 0) return {};
  const prompt = [
    `Draft concise slide body copy (${input.locale === 'en' ? 'English' : 'Japanese'}) for these sections of "${input.title}".`,
    input.tone ? `Tone: ${input.tone}` : '',
    input.audience ? `Audience: ${input.audience}` : '',
    'Context sections (titles only where body is missing):',
    ...input.sections.map(
      (section) =>
        `- ${section.id}: ${section.title}${section.body ? ' (already written)' : ' (NEEDS BODY)'}`
    ),
    '',
    'Reply with ONLY a JSON object mapping section id -> body text (2-4 sentences each),',
    'covering exactly the NEEDS BODY sections.',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const generate =
      input.generate ??
      (async (p: string) => {
        const { getReasoningBackend } = await import('./reasoning-backend.js');
        return String(await getReasoningBackend().prompt(p));
      });
    const raw = await generate(prompt);
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    if (!parsed || typeof parsed !== 'object') return {};
    const emptyIds = new Set(empty.map((section) => section.id));
    const drafts: Record<string, string> = {};
    for (const [id, body] of Object.entries(parsed)) {
      if (!emptyIds.has(id)) continue;
      const text = String(body ?? '').trim();
      if (text) drafts[id] = text.slice(0, 1200);
    }
    return drafts;
  } catch (error: any) {
    logger.warn(
      `section body drafting failed, keeping outline unchanged: ${error?.message || error}`
    );
    return {};
  }
}

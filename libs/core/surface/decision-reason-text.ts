/**
 * Decision cards store their gate reasons as text rendered in the server's
 * locale at creation time (`describeGateEscalations`), so a Japanese reader
 * could see "The agent asked for your judgment". This classifier recognizes
 * a stored reason in any supported locale and returns the matching concierge
 * vocabulary key (`ux_b_reason_*`) with its params, so the brief renders in
 * the reader's locale. Unknown text returns undefined and stays as written.
 *
 * Server-side (reads the vocabulary through `t`); `decision-brief.ts` stays
 * browser-safe and receives this through `DecisionBriefOptions.reasonText`.
 */
import { SUPPORTED_LOCALES } from '../locale-normalize.js';
import { t } from '../t.js';
import type { VocabularyKey } from '../knowledge/vocabulary-keys.generated.js';
import type { DisplayText } from './display-humanize.js';

/** `decision:` gate reason → its params, in template order. */
const GATE_REASONS: Readonly<Record<string, readonly string[]>> = {
  reason_axis_max: ['axes'],
  reason_irreversible: [],
  reason_never_auto: ['classes'],
  reason_high_risk_path: ['paths'],
  reason_requested: [],
  reason_budget: [],
  reason_score: ['score', 'max'],
};

interface ReasonMatcher {
  key: string;
  params: readonly string[];
  pattern: RegExp;
}

let matchers: ReasonMatcher[] | null = null;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function buildMatchers(): ReasonMatcher[] {
  const built: ReasonMatcher[] = [];
  for (const [reason, params] of Object.entries(GATE_REASONS)) {
    const sentinels = Object.fromEntries(params.map((name, i) => [name, `\u0000${i}\u0000`]));
    for (const locale of SUPPORTED_LOCALES) {
      let rendered: string;
      try {
        rendered = t(`decision:${reason}` as VocabularyKey, sentinels, locale);
      } catch {
        continue;
      }
      if (!rendered || rendered.includes(`decision:${reason}`)) continue;
      let source = escapeRegExp(rendered.trim());
      params.forEach((_, i) => {
        source = source.replace(escapeRegExp(`\u0000${i}\u0000`), '(.+?)');
      });
      built.push({ key: `ux_b_${reason}`, params, pattern: new RegExp(`^${source}$`, 'u') });
    }
  }
  return built;
}

/**
 * List params name machine things (repository paths, risk-axis and operation
 * class codes). The card body never shows them: a path list becomes its count
 * and the code lists are dropped (the concierge templates take no list); the
 * stored reason stays whole in the brief's details disclosure.
 */
function bodyParams(
  captured: Readonly<Record<string, string>>
): Record<string, string | number> | undefined {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(captured)) {
    if (name === 'paths')
      params.count = value.split(/[,、]/u).filter((entry) => entry.trim()).length;
    else if (name !== 'axes' && name !== 'classes') params[name] = value;
  }
  return Object.keys(params).length ? params : undefined;
}

export function decisionReasonText(text: string | undefined | null): DisplayText | undefined {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  matchers ??= buildMatchers();
  for (const matcher of matchers) {
    const match = matcher.pattern.exec(value);
    if (!match) continue;
    const params = bodyParams(
      Object.fromEntries(matcher.params.map((name, i) => [name, match[i + 1] ?? '']))
    );
    return params ? { key: matcher.key, params } : { key: matcher.key };
  }
  return undefined;
}

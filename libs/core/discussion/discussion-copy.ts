import { pathResolver } from '../path-resolver.js';
import { readJson } from '../foundation/json.js';
import type { DiscussionPerformative, DiscussionStance } from './discussion-types.js';

export type Locale = 'ja' | 'en';
export type Localized = { ja: string; en: string };

export interface ScriptStep extends Localized {
  performative: DiscussionPerformative;
  stance: DiscussionStance;
}

/**
 * User-facing prose for the Discussion Room lives in
 * `knowledge/product/orchestration/discussion-copy.json` (data, ja/en), never
 * inline in code, so copy can be translated and reviewed without touching the
 * engine.
 */
export interface DiscussionCopy {
  role_labels: Record<string, Localized>;
  discretionary_roles: Array<{ role: string; keywords: string }>;
  agenda: Array<{ id: string } & Localized>;
  vote_options: Record<Locale, string[]>;
  facilitator_frame: Localized;
  respond_human: Localized;
  summary: {
    text: Localized;
    tail_open: Localized;
    tail_done: Localized;
    issue_oppose: Localized;
    issue_question: Localized;
    agreement: Localized;
  };
  decision: {
    summary: Localized;
    default_agreement: Localized;
    next_steps: Record<Locale, string[]>;
  };
  scripts: Record<string, ScriptStep[]>;
  generic_script: ScriptStep[];
}

let cached: DiscussionCopy | undefined;

export function loadDiscussionCopy(): DiscussionCopy {
  cached ??= readJson<DiscussionCopy>(
    pathResolver.knowledge('product/orchestration/discussion-copy.json')
  );
  return cached;
}

/** Replace `{name}` placeholders; unknown placeholders are left visible. */
export function fillCopy(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole
  );
}

export function discussionRoleLabel(role: string, locale: Locale): string {
  return loadDiscussionCopy().role_labels[role]?.[locale] ?? role;
}

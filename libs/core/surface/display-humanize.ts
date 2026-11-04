/**
 * Display humanizer — pure helpers that keep machine text (hashes, repository
 * paths, JSON blobs, actor ids) out of the body of a card a person reads.
 *
 * Nothing here decides anything: the raw text stays available for a "詳細"
 * disclosure; these helpers only shape what the card body shows. No I/O and
 * no vocabulary lookup, so a browser bundle can import this module: localized
 * strings come back as `{ key, params }` for the surface to render.
 */

/** A localized line (concierge vocabulary key) or text that is already human. */
export type DisplayText =
  { key: string; params?: Record<string, string | number> } | { text: string };

/** 64-hex digests (and other long hex ids, ≥ 32 chars). */
const LONG_HEX = /\b[0-9a-f]{32,}\b/giu;
/** `:` followed by a long hex id (`pipeline:abc…`, `external:abc…`). */
const PREFIXED_HEX = /\b[a-z][\w-]*:[0-9a-f]{32,}\b/giu;
/** Absolute filesystem paths and repository-relative paths with two or more segments. */
const PATH_LIKE =
  /(?:\/(?:Users|Volumes|private|tmp|var|home|opt)\/[^\s"'`)]+)|(?:\b(?:active|knowledge|libs|scripts|pipelines|presence|tests|docs|dist)\/[^\s"'`)]+)/gu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

export interface StripMachineTextResult {
  text: string;
  /** True when anything was removed (the surface may point at 詳細). */
  stripped: boolean;
}

/** Removes `{…}` / `[…]` spans that parse as JSON objects or arrays. */
function stripJsonBlobs(text: string): { text: string; stripped: boolean } {
  let out = '';
  let stripped = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '{' || (char === '[' && /^\[\s*[{["\d]/u.test(text.slice(index, index + 4)))) {
      const end = matchingClose(text, index);
      if (end > index) {
        const candidate = text.slice(index, end + 1);
        try {
          JSON.parse(candidate);
          stripped = true;
          index = end + 1;
          continue;
        } catch {
          // not JSON — keep the character
        }
      }
    }
    out += char;
    index += 1;
  }
  return { text: out, stripped };
}

function matchingClose(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strips JSON blobs, long hex digests (alone or `prefix:`-ed), UUIDs and
 * repository / filesystem paths, then drops list lines left empty (`- Created`)
 * and collapses whitespace.
 */
export function stripMachineText(input: string | undefined | null): StripMachineTextResult {
  const source = String(input ?? '');
  const json = stripJsonBlobs(source);
  let stripped = json.stripped;
  const replace = (text: string, pattern: RegExp) =>
    text.replace(pattern, () => {
      stripped = true;
      return '';
    });
  let text = json.text;
  text = replace(text, PATH_LIKE);
  text = replace(text, PREFIXED_HEX);
  text = replace(text, UUID);
  text = replace(text, LONG_HEX);
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    // A list line whose object was removed ("- Created") says nothing. Runs
    // of whitespace are already single spaces here, so the pattern needs no
    // nested `\s*` (which backtracks polynomially on long tab runs).
    .filter((line) => line !== '' && !/^[-*•] ?\w* ?[:：]?$/u.test(line));
  const joined = lines
    .join(' ')
    // Brackets whose content was removed.
    .replace(/\(\s*\)|（\s*）|\[\s*\]|「\s*」/gu, '')
    .replace(/\s+([.,。、])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  return { text: joined, stripped };
}

export interface ClampedText {
  /** What the card shows by default. */
  short: string;
  /** The whole (already stripped) text, for the "show more" disclosure. */
  full: string;
  clamped: boolean;
}

/** Roughly two card lines. */
export const DEFAULT_CLAMP_CHARS = 140;

/** Cuts at a sentence or word boundary near `maxChars`, adding an ellipsis. */
export function clampText(input: string, maxChars = DEFAULT_CLAMP_CHARS): ClampedText {
  const full = input.trim();
  if (full.length <= maxChars) return { short: full, full, clamped: false };
  const window = full.slice(0, maxChars);
  const boundary = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('. '),
    window.lastIndexOf('、'),
    window.lastIndexOf(' — '),
    window.lastIndexOf(', ')
  );
  const space = window.lastIndexOf(' ');
  const cut =
    boundary >= maxChars * 0.5 ? boundary + 1 : space >= maxChars * 0.6 ? space : maxChars;
  return { short: `${full.slice(0, cut).trimEnd()}…`, full, clamped: true };
}

/** Strip, then clamp: the one call a card body needs. */
export function humanizeSummary(
  input: string | undefined | null,
  maxChars = DEFAULT_CLAMP_CHARS
): ClampedText & { stripped: boolean } {
  const { text, stripped } = stripMachineText(input);
  return { ...clampText(text, maxChars), stripped };
}

/** `MSN-CONT-B73…: `, `WI-12: ` — an uppercase entity id used as a title prefix. */
const ID_PREFIX = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\s*[:：]\s*/u;

/**
 * Drops a leading entity id (`MSN-…: Do the thing` → `Do the thing`) when a
 * title remains; the id belongs in a chip or the detail view, not the heading.
 */
export function stripIdPrefix(title: string | undefined | null): string {
  const text = String(title ?? '').trim();
  const rest = text.replace(ID_PREFIX, '').trim();
  return rest || text;
}

/** Display names the surface already knows (members, agents), by actor id. */
export type ActorNameLookup = (actorId: string) => string | undefined;

const SERVICE_ACTOR_KEYS: Record<string, string> = {
  'vcs-publication-cli': 'ux_a_actor_publication',
  'pipeline-external-worker': 'ux_a_actor_pipeline',
  'system-actuator': 'ux_a_actor_system',
  system: 'ux_a_actor_system',
  concierge: 'ux_a_actor_system',
  sovereign: 'ux_a_actor_system',
};

function slugToName(slug: string): string {
  return slug
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * An actor id as a person reads it. Known members and agents use their
 * display name; machine actors (`pipeline:<hash>`, `vcs-publication-cli`, …)
 * become a localized "自動処理（…）" label; a bare hash never reaches the card.
 */
export function describeActor(
  actorId: string | undefined | null,
  names?: ActorNameLookup
): DisplayText {
  const id = String(actorId ?? '').trim();
  if (!id) return { key: 'ux_a_actor_automation' };
  const known = names?.(id);
  if (known && known !== id) return { text: known };
  if (SERVICE_ACTOR_KEYS[id]) return { key: SERVICE_ACTOR_KEYS[id] };
  const agentRef = /^kyberion:\/\/agent\/[^/]+\/([^/]+)$/u.exec(id);
  if (agentRef) return { key: 'ux_a_actor_agent', params: { name: slugToName(agentRef[1]!) } };
  const [prefix, ...rest] = id.split(':');
  const value = rest.join(':');
  if (rest.length > 0 && value) {
    switch (prefix) {
      case 'pipeline':
        return { key: 'ux_a_actor_pipeline' };
      case 'dot':
        return { key: 'ux_a_actor_dot', params: { name: slugToName(value) } };
      case 'agent':
        return { key: 'ux_a_actor_agent', params: { name: slugToName(value) } };
      case 'user':
      case 'human':
      case 'member':
        return { text: names?.(value) ?? value };
      default:
        break;
    }
  }
  if (/^[0-9a-f]{16,}$/iu.test(id) || /[0-9a-f]{32,}/iu.test(id)) {
    return { key: 'ux_a_actor_automation' };
  }
  return { text: id.length > 48 ? `${id.slice(0, 47)}…` : id };
}

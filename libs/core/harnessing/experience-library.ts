/**
 * Domain-scoped, causally-ordered experience library (harness2 library.py
 * import). Each domain is a JSONL file `<domain>.jsonl` under the library
 * root; appendLesson stamps a cue/lesson/evidence/confidence row with
 * recorded_at and appends it. lookupLessons returns ONLY entries with
 * recorded_at <= asOf — a session may read lessons recorded before it,
 * never after (harness2 `retain` semantics). Retrieval is by construction:
 * a domain file physically holds only that domain's entries.
 */

import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
} from '../secure-io.js';
import { nowIso } from '../foundation/time.js';

export interface LessonInput {
  /** The work shape / situation this lesson applies to. */
  cue: string;
  lesson: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExperienceEntry extends LessonInput {
  /** ISO stamp assigned at append time — the causal-order key. */
  recorded_at: string;
}

const CONFIDENCES = ['high', 'medium', 'low'] as const;

/** The domain becomes a filename — it must satisfy the label charset so it
 *  can never escape the library root (e.g. '../x'). */
function assertDomain(domain: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(domain)) {
    throw new Error(
      `[EXPERIENCE_LIBRARY] domain ${JSON.stringify(domain)} must match [A-Za-z0-9][A-Za-z0-9_-]*`
    );
  }
}

function domainFilePath(libraryRoot: string, domain: string): string {
  const root = assertSafeRepositoryPath(libraryRoot, { allowMissingLeaf: true });
  assertDomain(domain);
  return path.join(root, `${domain}.jsonl`);
}

export function appendLesson(opts: {
  libraryRoot: string;
  domain: string;
  entry: LessonInput;
}): string {
  const { entry } = opts;
  for (const field of ['cue', 'lesson', 'evidence'] as const) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) {
      throw new Error(`[EXPERIENCE_LIBRARY] entry.${field} must be a non-empty string`);
    }
  }
  if (!CONFIDENCES.includes(entry.confidence)) {
    throw new Error(
      `[EXPERIENCE_LIBRARY] entry.confidence must be high|medium|low, got ${JSON.stringify(
        entry.confidence
      )}`
    );
  }
  const root = assertSafeRepositoryPath(opts.libraryRoot, { allowMissingLeaf: true });
  safeMkdir(root, { recursive: true });
  const file = domainFilePath(opts.libraryRoot, opts.domain);
  const row: ExperienceEntry = { ...entry, recorded_at: nowIso() };
  safeAppendFileSync(file, `${JSON.stringify(row)}\n`);
  return file;
}

export function lookupLessons(opts: {
  libraryRoot: string;
  domain: string;
  /** Case-insensitive substring matched against cue OR lesson text. */
  cue?: string;
  /** Causal horizon: only entries with recorded_at <= asOf are visible. */
  asOf?: string;
}): ExperienceEntry[] {
  const file = domainFilePath(opts.libraryRoot, opts.domain);
  if (!safeExistsSync(file)) return [];
  const needle = opts.cue ? opts.cue.toLowerCase() : '';
  const out: ExperienceEntry[] = [];
  const lines = String(safeReadFile(file)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: ExperienceEntry;
    try {
      entry = JSON.parse(line) as ExperienceEntry;
    } catch {
      throw new Error(`[EXPERIENCE_LIBRARY] malformed JSONL line ${i + 1} in ${file}`);
    }
    // Causal order: an entry recorded after the horizon is invisible — a
    // session must not learn from runs that had not happened yet.
    if (opts.asOf && String(entry.recorded_at) > opts.asOf) continue;
    if (needle) {
      const hay = `${String(entry.cue ?? '')}\n${String(entry.lesson ?? '')}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    out.push(entry);
  }
  return out;
}

/** Render matched lessons as a short prompt block for propose-stage seeding.
 *  Returns '' for an empty set so callers can splice unconditionally. */
export function seedPromptFromLessons(entries: ExperienceEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map(
    (e) => `- [${e.confidence}] ${e.cue}: ${e.lesson} (evidence: ${e.evidence})`
  );
  return ['Prior lessons in this domain (recorded before this session):', ...lines].join('\n');
}

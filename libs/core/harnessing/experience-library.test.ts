import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  appendLesson,
  lookupLessons,
  seedPromptFromLessons,
  type ExperienceEntry,
} from './experience-library.js';

const ROOT = path.join(process.cwd(), 'active/shared/tmp/harnessing-library-test');

const entry = (cue: string, lesson: string, confidence: 'high' | 'medium' | 'low' = 'medium') => ({
  cue,
  lesson,
  evidence: 'probe outcomes under runs/',
  confidence,
});

function seedFile(domain: string, rows: ExperienceEntry[]): string {
  const dir = path.join(ROOT, 'seeded');
  safeMkdir(dir, { recursive: true });
  const file = path.join(dir, `${domain}.jsonl`);
  safeWriteFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const row = (over: Partial<ExperienceEntry>): ExperienceEntry => ({
  cue: 'probe tuning',
  lesson: 'apply the winning overlay',
  evidence: 'e',
  confidence: 'high',
  recorded_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('appendLesson + lookupLessons', () => {
  it('roundtrips an appended entry with a recorded_at stamp', () => {
    // The library is append-only — reset it so reruns don't see stale rows.
    safeRmSync(path.join(ROOT, 'rt'));
    const file = appendLesson({
      libraryRoot: path.join(ROOT, 'rt'),
      domain: 'contrastive',
      entry: entry('probe tuning', 'winner dominated base'),
    });
    expect(file.endsWith('contrastive.jsonl')).toBe(true);
    const found = lookupLessons({ libraryRoot: path.join(ROOT, 'rt'), domain: 'contrastive' });
    expect(found).toHaveLength(1);
    expect(found[0].lesson).toBe('winner dominated base');
    expect(found[0].recorded_at).toBeTruthy();
    // JSONL: one line per entry.
    expect(String(safeReadFile(file)).trim().split('\n')).toHaveLength(1);
  });

  it('hides entries recorded after the asOf horizon (causal order)', () => {
    seedFile('causal', [
      row({ lesson: 'early lesson', recorded_at: '2026-01-01T00:00:00.000Z' }),
      row({ lesson: 'late lesson', recorded_at: '2026-01-03T00:00:00.000Z' }),
    ]);
    const seen = lookupLessons({
      libraryRoot: path.join(ROOT, 'seeded'),
      domain: 'causal',
      asOf: '2026-01-02T00:00:00.000Z',
    });
    expect(seen.map((e) => e.lesson)).toEqual(['early lesson']);
    // No horizon -> everything is visible.
    expect(
      lookupLessons({ libraryRoot: path.join(ROOT, 'seeded'), domain: 'causal' })
    ).toHaveLength(2);
  });

  it('matches cue case-insensitively against cue OR lesson text', () => {
    seedFile('cuex', [
      row({ cue: 'PPTX decks', lesson: 'nothing relevant here' }),
      row({ cue: 'other', lesson: 'the PROBE won on wall_ms' }),
      row({ cue: 'other', lesson: 'unrelated' }),
    ]);
    const seen = lookupLessons({
      libraryRoot: path.join(ROOT, 'seeded'),
      domain: 'cuex',
      cue: 'probe',
    });
    expect(seen.map((e) => e.lesson)).toEqual(['the PROBE won on wall_ms']);
  });

  it('treats an empty cue as no filter', () => {
    seedFile('emptycue', [row({ lesson: 'a' }), row({ lesson: 'b' })]);
    expect(
      lookupLessons({ libraryRoot: path.join(ROOT, 'seeded'), domain: 'emptycue', cue: '' })
    ).toHaveLength(2);
  });

  it('returns [] for a domain that has no file yet', () => {
    expect(
      lookupLessons({ libraryRoot: path.join(ROOT, 'seeded'), domain: 'nonexistent' })
    ).toEqual([]);
  });
});

describe('appendLesson validation', () => {
  const base = { libraryRoot: path.join(ROOT, 'val'), domain: 'd1' };
  it('rejects empty required fields', () => {
    expect(() => appendLesson({ ...base, entry: entry('', 'lesson') })).toThrow(/entry\.cue/);
    expect(() => appendLesson({ ...base, entry: entry('cue', '  ') })).toThrow(/entry\.lesson/);
    expect(() =>
      appendLesson({ ...base, entry: { ...entry('cue', 'lesson'), evidence: '' } })
    ).toThrow(/entry\.evidence/);
  });
  it('rejects a bad confidence and a path-unsafe domain', () => {
    expect(() =>
      appendLesson({
        ...base,
        entry: { ...entry('cue', 'lesson'), confidence: 'sure' as 'high' },
      })
    ).toThrow(/confidence/);
    expect(() =>
      appendLesson({ ...base, domain: '../escape', entry: entry('cue', 'lesson') })
    ).toThrow(/domain/);
  });
});

describe('seedPromptFromLessons', () => {
  it('renders a prompt block and returns empty for no entries', () => {
    expect(seedPromptFromLessons([])).toBe('');
    const text = seedPromptFromLessons([row({ cue: 'probe tuning', lesson: 'use dom1' })]);
    expect(text).toContain('Prior lessons');
    expect(text).toContain('probe tuning');
    expect(text).toContain('use dom1');
    expect(text).toContain('[high]');
  });
});

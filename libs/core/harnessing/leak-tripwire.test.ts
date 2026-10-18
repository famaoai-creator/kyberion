import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { DEFAULT_MARKERS, scanOverlayForMarkers } from './leak-tripwire.js';

const ROOT = path.join(process.cwd(), 'active/shared/tmp/harnessing-tripwire-test');

function overlay(label: string, files: Record<string, string>): string {
  const dir = path.join(ROOT, 'ov', label);
  for (const [rel, content] of Object.entries(files)) {
    const t = path.join(dir, rel);
    safeMkdir(path.dirname(t), { recursive: true });
    safeWriteFile(t, content);
  }
  return dir;
}

describe('scanOverlayForMarkers', () => {
  it('reports a clean overlay as clean', () => {
    const r = scanOverlayForMarkers(overlay('clean', { 'note.txt': 'hello\nworld\n' }));
    expect(r.clean).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it('rejects a marker-bearing file with path + line location', () => {
    const r = scanOverlayForMarkers(
      overlay('dirty', { 'sub/leak.md': 'line one\nthe grader expects X\nline three\n' })
    );
    expect(r.clean).toBe(false);
    expect(r.hits).toEqual([{ path: 'sub/leak.md', marker: 'the grader expects', line: 2 }]);
  });

  it('honours caller-supplied extra markers merged with the defaults', () => {
    const r = scanOverlayForMarkers(overlay('extra', { 'a.txt': 'contains sekrit_token\n' }), [
      'sekrit_token',
    ]);
    expect(r.clean).toBe(false);
    expect(r.hits[0].marker).toBe('sekrit_token');
    // Defaults still apply when extras are given.
    const r2 = scanOverlayForMarkers(overlay('extra2', { 'b.txt': 'answer_key = 42\n' }), [
      'sekrit_token',
    ]);
    expect(r2.hits[0].marker).toBe('answer_key');
  });

  it('fails closed on a missing overlay dir', () => {
    const r = scanOverlayForMarkers(path.join(ROOT, 'ov', 'does-not-exist'));
    expect(r.clean).toBe(false);
    expect(r.hits[0].marker).toBe('<overlay-unreadable>');
  });

  it('ships the documented default marker set', () => {
    expect(DEFAULT_MARKERS).toEqual(
      expect.arrayContaining([
        'the grader expects',
        'answer_key',
        'rubric',
        'eval_score',
        'golden_output',
        'expected_answer',
      ])
    );
  });
});

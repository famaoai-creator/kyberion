/**
 * Leak tripwire (harness2 leak_globs / grader-verdict marker scan import):
 * a save-time content scan run on every candidate overlay before it reaches
 * a probe. A file carrying a grader/answer marker can never be probed — and
 * can never be served as evidence to a later run. The rule when a tripwire
 * fires: fix the read path, do not widen the marker list.
 */

import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeReadFile,
} from '../secure-io.js';

/**
 * Default content markers. Callers may extend this list via the `markers`
 * parameter — extras are merged with these defaults; there is no way to
 * subtract a default marker from inside a scan call.
 */
export const DEFAULT_MARKERS: string[] = [
  'the grader expects',
  'answer_key',
  'rubric',
  'eval_score',
  'golden_output',
  'expected_answer',
];

export interface LeakHit {
  /** Path relative to the overlay dir ('.' for a dir-level failure). */
  path: string;
  /** The marker that matched — '<overlay-unreadable>' / '<file-unreadable>'
   *  when the tripwire failed closed on unreadable input. */
  marker: string;
  /** 1-based line number; 0 when no line could be attributed. */
  line: number;
}

export interface LeakScanResult {
  clean: boolean;
  hits: LeakHit[];
}

function listFiles(dir: string, hits: LeakHit[], prefix = ''): string[] {
  const out: string[] = [];
  if (!safeExistsSync(dir)) return out;
  let entries: string[];
  try {
    entries = safeReaddir(dir).sort();
  } catch {
    hits.push({ path: prefix || '.', marker: '<dir-unreadable>', line: 0 });
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    let stat;
    try {
      stat = safeLstat(p);
    } catch {
      hits.push({ path: rel, marker: '<file-unreadable>', line: 0 });
      continue;
    }
    if (stat.isDirectory()) out.push(...listFiles(p, hits, rel));
    else if (stat.isFile()) out.push(rel);
    else hits.push({ path: rel, marker: '<non-file entry skipped>', line: 0 });
  }
  return out;
}

/** Scan every file under overlayDir for marker strings. Fails closed: an
 *  unreadable dir or file is reported as a hit, never as clean. */
export function scanOverlayForMarkers(overlayDir: string, markers?: string[]): LeakScanResult {
  const markerList = [...DEFAULT_MARKERS, ...(markers ?? [])].map((m) => m.trim()).filter(Boolean);
  const dir = assertSafeRepositoryPath(overlayDir, { allowMissingLeaf: true });
  if (!safeExistsSync(dir) || !safeLstat(dir).isDirectory()) {
    return {
      clean: false,
      hits: [{ path: '.', marker: '<overlay-unreadable>', line: 0 }],
    };
  }
  const hits: LeakHit[] = [];
  const lowerMarkers = markerList.map((m) => m.toLowerCase());
  for (const rel of listFiles(dir, hits)) {
    let text: string;
    try {
      text = String(safeReadFile(path.join(dir, rel)));
    } catch {
      hits.push({ path: rel, marker: '<file-unreadable>', line: 0 });
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lowLine = lines[i].toLowerCase();
      for (let mi = 0; mi < lowerMarkers.length; mi++) {
        if (lowLine.includes(lowerMarkers[mi])) {
          // One hit per line is enough to reject the overlay.
          hits.push({ path: rel, marker: markerList[mi], line: i + 1 });
          break;
        }
      }
    }
  }
  return { clean: hits.length === 0, hits };
}

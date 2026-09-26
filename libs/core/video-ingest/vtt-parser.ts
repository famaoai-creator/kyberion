import type { TranscriptSegment } from './video-ingest-types.js';

const TIMESTAMP = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/;
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function parseVttTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
}

/** Strip inline cue tags (`<c>`, `<00:00:01.000>`, `<v Speaker>`) and decode basic entities. */
function cleanCueLine(line: string): string {
  let text = '';
  let inTag = false;
  for (const char of line) {
    if (char === '<') inTag = true;
    else if (char === '>' && inTag) inTag = false;
    else if (!inTag) text += char;
  }
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

interface RawCue {
  start_sec: number;
  end_sec: number;
  lines: string[];
}

function parseCues(text: string): RawCue[] {
  const cues: RawCue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startRaw, rest = ''] = lines[timingIndex].split('-->');
    const endRaw = rest.trim().split(/\s+/)[0] ?? '';
    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(endRaw);
    if (start === null || end === null) continue;
    const cueLines = lines
      .slice(timingIndex + 1)
      .map(cleanCueLine)
      .filter((line) => line.length > 0);
    cues.push({ start_sec: start, end_sec: Math.max(start, end), lines: cueLines });
  }
  return cues;
}

/** Longest k such that the first k cue lines repeat the last k emitted lines. */
function repeatedPrefixLength(lines: string[], recent: string[]): number {
  for (let k = Math.min(lines.length, recent.length); k > 0; k -= 1) {
    const tail = recent.slice(recent.length - k);
    if (tail.every((line, index) => line === lines[index])) return k;
  }
  return 0;
}

/**
 * Parse WebVTT into transcript segments. Rolling auto-captions repeat the
 * previous line at the top of each cue (and emit ~10ms transition cues that
 * only repeat it); those repeats are dropped so every spoken line appears once.
 */
export function parseVtt(text: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const recent: string[] = [];
  for (const cue of parseCues(text)) {
    const fresh = cue.lines.slice(repeatedPrefixLength(cue.lines, recent));
    if (fresh.length === 0) {
      const last = segments[segments.length - 1];
      if (last && cue.lines.length > 0) last.end_sec = Math.max(last.end_sec, cue.end_sec);
      continue;
    }
    segments.push({ start_sec: cue.start_sec, end_sec: cue.end_sec, text: fresh.join(' ') });
    recent.push(...fresh);
    if (recent.length > 4) recent.splice(0, recent.length - 4);
  }
  return segments;
}

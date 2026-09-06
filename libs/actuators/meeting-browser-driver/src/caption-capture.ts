/**
 * Live-caption capture core for the browser meeting driver.
 *
 * The driver joins Meet / Zoom / Teams with Playwright and reads the
 * platforms' own live captions out of the DOM — no system-audio
 * loopback, no vendor SDK. This module holds the pure pieces
 * (line parsing, snapshot diffing, transcript rendering) so they stay
 * unit-testable without a browser; the polling loop lives in
 * `index.ts` next to the page handle.
 */

export interface CaptionCue {
  /** Seconds since capture start. */
  tSec: number;
  speaker: string;
  text: string;
}

export function parseCaptionLine(line: string): { speaker: string; text: string } {
  const match = line.match(/^\s*([^:：]{1,64})\s*[:：]\s*(.*)$/u);
  if (match) return { speaker: match[1].trim(), text: match[2].trim() };
  return { speaker: '', text: line.trim() };
}

/**
 * Lines in `current` not present in `previous` (exact match), in order.
 * Live-caption regions update in place and repeat lines across polls;
 * the seen-set keeps the transcript append-only.
 */
export function diffCaptionLines(
  previous: readonly string[],
  current: readonly string[]
): string[] {
  const seen = new Set(previous);
  const fresh: string[] = [];
  for (const line of current) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    fresh.push(trimmed);
  }
  return fresh;
}

function formatCueTime(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.floor(totalSec % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Render cues as `[mm:ss] Speaker: text` lines — the same shape
 * `meeting:normalize_transcript` passes through, so captured files
 * flow straight into `pipelines/meeting-followup.json`.
 */
export function formatTranscriptCues(cues: readonly CaptionCue[]): string {
  return cues
    .map((cue) => `[${formatCueTime(cue.tSec)}] ${cue.speaker || 'Unknown'}: ${cue.text}`)
    .join('\n');
}

/**
 * Runs INSIDE the page via `page.evaluate`. Takes caption-container
 * selectors, returns visible caption lines in DOM order. Deliberately
 * dependency-free (no closures) so it serializes cleanly.
 */
export function scrapeCaptionLines(containers: string[]): string[] {
  const out: string[] = [];
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc) return out;
  for (const selector of containers) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of Array.from(nodes)) {
      const element = node as HTMLElement;
      const visible = typeof element.isConnected === 'boolean' ? element.isConnected : true;
      if (!visible) continue;
      const text = (element.innerText || '').trim();
      if (text) out.push(text);
    }
  }
  return out;
}

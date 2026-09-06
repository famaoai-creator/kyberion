/**
 * Extension caption JSONL → transcript text.
 *
 * The chrome-extension meeting driver persists live captions as JSONL
 * (`tmp/meeting-captions-<session>.jsonl`, one `{ text, speaker?, ts }`
 * object per line). This module renders those lines as
 * `[mm:ss] Speaker: text` — the same shape `meeting:normalize_transcript`
 * passes through — so extension sessions flow into `meeting-followup`
 * without a dedicated branch. Pure functions only.
 */

export interface ExtensionCaptionLine {
  text?: string;
  speaker?: string;
  ts?: string;
}

function parseLine(raw: string): ExtensionCaptionLine | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as ExtensionCaptionLine;
  } catch {
    return undefined;
  }
}

function formatCueTime(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.floor(totalSec % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Render JSONL caption lines. Timestamps are relative to the first
 * valid `ts`; lines without text are skipped; consecutive same-speaker
 * lines merge, mirroring `normalizeTranscriptText`.
 */
export function extensionCaptionsToTranscript(jsonl: string): {
  transcript: string;
  cueCount: number;
  speakers: string[];
} {
  const lines = jsonl
    .split('\n')
    .map(parseLine)
    .filter(
      (line): line is ExtensionCaptionLine =>
        Boolean(line) && typeof line?.text === 'string' && line.text.trim().length > 0
    );
  const baseMs = (() => {
    for (const line of lines) {
      const ms = line.ts ? Date.parse(line.ts) : Number.NaN;
      if (Number.isFinite(ms)) return ms;
    }
    return undefined;
  })();
  const merged: Array<{ tSec: number; speaker: string; text: string }> = [];
  for (const line of lines) {
    const ms = line.ts ? Date.parse(line.ts) : Number.NaN;
    const tSec =
      baseMs !== undefined && Number.isFinite(ms)
        ? Math.max(0, Math.round((ms - baseMs) / 1000))
        : 0;
    const speaker = String(line.speaker || '').trim() || 'Unknown';
    const text = String(line.text || '').trim();
    const previous = merged[merged.length - 1];
    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${text}`.trim();
    } else {
      merged.push({ tSec, speaker, text });
    }
  }
  return {
    transcript: merged
      .map((cue) => `[${formatCueTime(cue.tSec)}] ${cue.speaker}: ${cue.text}`)
      .join('\n'),
    cueCount: merged.length,
    speakers: [...new Set(merged.map((cue) => cue.speaker))],
  };
}

/**
 * Transcript normalization for meeting intake.
 *
 * Zoom / Meet / Teams export WebVTT or SubRip (SRT); smartphone STT and
 * hand-written minutes arrive as plain text. This module parses cue-based
 * formats into uniform `[mm:ss] Speaker: text` lines so downstream ops
 * (`extract_action_items`, minutes drafting) see one stable shape.
 * Pure functions only — no IO, no LLM.
 */

export interface NormalizedCue {
  startSec: number;
  speaker: string;
  text: string;
}

export interface NormalizeTranscriptOptions {
  /** Known attendees for speaker-name resolution (strings or `{ name }`). */
  attendees?: Array<string | { name?: string }>;
  /** Explicit alias map: raw label (case-insensitive) → canonical name. */
  speakerAliases?: Record<string, string>;
}

export interface NormalizedTranscript {
  format: 'vtt' | 'srt' | 'text';
  transcript: string;
  cueCount: number;
  speakers: string[];
}

function timestampToSec(stamp: string): number {
  const normalized = stamp.trim().replace(',', '.');
  const parts = normalized.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.max(0, seconds);
}

function formatSec(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.floor(totalSec % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function stripCueMarkup(text: string): string {
  return text
    .replace(/<\s*v\s+([^>]+)>/giu, '$1: ')
    .replace(/<\/\s*v\s*>/giu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .trim();
}

function splitSpeaker(line: string): { speaker: string; text: string } {
  const match = line.match(/^\s*([^:：]{1,64})\s*[:：]\s*(.*)$/u);
  if (match) return { speaker: match[1].trim(), text: match[2].trim() };
  return { speaker: '', text: line.trim() };
}

const TIMESTAMP_LINE =
  /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/u;

function parseCueBlock(lines: string[], startIndex: number): { cue: NormalizedCue; next: number } {
  let index = startIndex;
  // Optional numeric (SRT) or opaque (VTT) cue identifier line.
  if (index < lines.length && !TIMESTAMP_LINE.test(lines[index])) index += 1;
  const timing = index < lines.length ? lines[index].match(TIMESTAMP_LINE) : null;
  const startSec = timing ? timestampToSec(timing[1]) : 0;
  index += 1;
  const textLines: string[] = [];
  while (index < lines.length && lines[index].trim() !== '') {
    textLines.push(lines[index]);
    index += 1;
  }
  const joined = stripCueMarkup(textLines.join(' ').trim());
  const { speaker, text } = splitSpeaker(joined);
  return { cue: { startSec, speaker, text }, next: index };
}

function parseCues(raw: string): NormalizedCue[] {
  const lines = raw.replace(/\r\n?/gu, '\n').split('\n');
  const cues: NormalizedCue[] = [];
  let index = 0;
  // Skip WEBVTT header / NOTE prologues.
  while (
    index < lines.length &&
    (lines[index].trim() === '' ||
      lines[index].startsWith('WEBVTT') ||
      lines[index].startsWith('NOTE'))
  ) {
    if (lines[index].startsWith('NOTE')) {
      while (index < lines.length && lines[index].trim() !== '') index += 1;
    }
    index += 1;
  }
  while (index < lines.length) {
    if (lines[index].trim() === '') {
      index += 1;
      continue;
    }
    const { cue, next } = parseCueBlock(lines, index);
    if (cue.text) cues.push(cue);
    index = Math.max(next, index + 1);
  }
  return cues;
}

function detectFormat(raw: string, fileName: string): 'vtt' | 'srt' | 'text' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.vtt')) return 'vtt';
  if (lower.endsWith('.srt')) return 'srt';
  const head = raw.slice(0, 4096);
  if (/^\s*WEBVTT/mu.test(head)) return 'vtt';
  if (/^\s*\d+\s*\n\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/mu.test(head)) return 'srt';
  return 'text';
}

function attendeeNames(attendees: NormalizeTranscriptOptions['attendees']): string[] {
  return (attendees ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

function resolveSpeaker(raw: string, aliases: Record<string, string>, attendees: string[]): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Unknown';
  const aliased = aliases[trimmed.toLowerCase()];
  if (aliased) return aliased;
  const exact = attendees.find((name) => name.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;
  const partial = attendees.find(
    (name) =>
      name.length >= 2 &&
      (name.toLowerCase().includes(trimmed.toLowerCase()) ||
        trimmed.toLowerCase().includes(name.toLowerCase()))
  );
  if (partial) return partial;
  return trimmed;
}

export function normalizeTranscriptText(
  raw: string,
  options: NormalizeTranscriptOptions = {},
  fileName = ''
): NormalizedTranscript {
  const format = detectFormat(raw, fileName);
  if (format === 'text') {
    const transcript = raw.replace(/\r\n?/gu, '\n').trim();
    return { format, transcript, cueCount: 0, speakers: [] };
  }
  const aliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.speakerAliases ?? {})) {
    aliases[key.toLowerCase()] = value;
  }
  const attendees = attendeeNames(options.attendees);
  const merged: NormalizedCue[] = [];
  for (const cue of parseCues(raw)) {
    const speaker = resolveSpeaker(cue.speaker, aliases, attendees);
    const previous = merged[merged.length - 1];
    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${cue.text}`.trim();
    } else {
      merged.push({ startSec: cue.startSec, speaker, text: cue.text });
    }
  }
  const transcript = merged
    .map((cue) => `[${formatSec(cue.startSec)}] ${cue.speaker}: ${cue.text}`)
    .join('\n');
  return {
    format,
    transcript,
    cueCount: merged.length,
    speakers: [...new Set(merged.map((cue) => cue.speaker))],
  };
}

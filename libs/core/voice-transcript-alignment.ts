import type { TranscriptSegment } from './speech-to-text-bridge.js';

export interface VoicePromptSegment {
  segment_id: string;
  text: string;
}

export interface VoiceTranscriptMismatch extends VoicePromptSegment {
  reason: 'not_found_in_transcript' | 'low_similarity' | 'no_timestamp_range';
  similarity?: number;
}

export interface VoiceTranscriptSegmentMatch {
  segment_id: string;
  start_sec: number;
  end_sec: number;
  transcript: string;
  similarity: number;
  match_kind: 'exact' | 'fuzzy' | 'positional';
}

export interface VoiceTranscriptVerification {
  status: 'passed' | 'needs_repair';
  transcript: string;
  expected_segments: VoicePromptSegment[];
  matched_segments: string[];
  mismatches: VoiceTranscriptMismatch[];
  segment_matches: VoiceTranscriptSegmentMatch[];
}

function normalizeJapaneseNumerals(text: string): string {
  return text
    .replaceAll('二十五', '25')
    .replaceAll('二十四', '24')
    .replaceAll('二十三', '23')
    .replaceAll('二十二', '22')
    .replaceAll('二十一', '21')
    .replaceAll('二十', '20')
    .replaceAll('十五', '15')
    .replaceAll('十四', '14')
    .replaceAll('十三', '13')
    .replaceAll('十二', '12')
    .replaceAll('十一', '11')
    .replaceAll('十', '10')
    .replaceAll('一', '1')
    .replaceAll('二', '2')
    .replaceAll('三', '3')
    .replaceAll('四', '4')
    .replaceAll('五', '5')
    .replaceAll('六', '6')
    .replaceAll('七', '7')
    .replaceAll('八', '8')
    .replaceAll('九', '9');
}

export function normalizeVoiceTranscript(text: string): string {
  return normalizeJapaneseNumerals(String(text || ''))
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s。、，．！？!?「」『』（）()［］[\],.:;・\-ー]/gu, '');
}

export function splitVoicePrompt(promptText: string): VoicePromptSegment[] {
  return String(promptText || '')
    .split(/(?<=[。！？!?])/u)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ segment_id: `segment-${String(index + 1).padStart(2, '0')}`, text }));
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previous = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const current = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      previous = current;
    }
  }
  return row[right.length];
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  return 1 - editDistance(left, right) / Math.max(left.length, right.length);
}

function findTimestampedMatch(
  expected: VoicePromptSegment,
  index: number,
  segments: TranscriptSegment[]
): VoiceTranscriptSegmentMatch | undefined {
  const expectedNormalized = normalizeVoiceTranscript(expected.text);
  for (let start = 0; start < segments.length; start += 1) {
    let combined = '';
    for (let end = start; end < segments.length; end += 1) {
      combined += normalizeVoiceTranscript(segments[end].text);
      if (combined.includes(expectedNormalized)) {
        return {
          segment_id: expected.segment_id,
          start_sec: segments[start].start_sec,
          end_sec: segments[end].end_sec,
          transcript: segments
            .slice(start, end + 1)
            .map((segment) => segment.text)
            .join(''),
          similarity: 1,
          match_kind: 'exact',
        };
      }
    }
  }

  const positional = segments[index];
  if (!positional) return undefined;
  const positionalSimilarity = similarity(
    expectedNormalized,
    normalizeVoiceTranscript(positional.text)
  );
  return {
    segment_id: expected.segment_id,
    start_sec: positional.start_sec,
    end_sec: positional.end_sec,
    transcript: positional.text,
    similarity: positionalSimilarity,
    match_kind: positionalSimilarity >= 0.87 ? 'fuzzy' : 'positional',
  };
}

export function verifyVoiceTranscript(
  promptText: string,
  transcript: string,
  transcriptSegments: TranscriptSegment[] = []
): VoiceTranscriptVerification {
  const expectedSegments = splitVoicePrompt(promptText);
  const normalizedTranscript = normalizeVoiceTranscript(transcript);
  const segmentMatches = expectedSegments
    .map((segment, index) => findTimestampedMatch(segment, index, transcriptSegments))
    .filter((match): match is VoiceTranscriptSegmentMatch => Boolean(match));
  const matchById = new Map(segmentMatches.map((match) => [match.segment_id, match]));
  const matchedSegments = expectedSegments.filter((segment) => {
    const expectedNormalized = normalizeVoiceTranscript(segment.text);
    if (normalizedTranscript.includes(expectedNormalized)) return true;
    const match = matchById.get(segment.segment_id);
    return Boolean(match && match.similarity >= 0.87);
  });
  const matchedIds = matchedSegments.map((segment) => segment.segment_id);
  const mismatches = expectedSegments
    .filter((segment) => !matchedIds.includes(segment.segment_id))
    .map((segment) => {
      const match = matchById.get(segment.segment_id);
      return {
        ...segment,
        reason: match
          ? ('low_similarity' as const)
          : transcriptSegments.length > 0
            ? ('no_timestamp_range' as const)
            : ('not_found_in_transcript' as const),
        ...(match ? { similarity: match.similarity } : {}),
      };
    });

  return {
    status: mismatches.length === 0 ? 'passed' : 'needs_repair',
    transcript: String(transcript || '').trim(),
    expected_segments: expectedSegments,
    matched_segments: matchedIds,
    mismatches,
    segment_matches: segmentMatches,
  };
}

/**
 * Shared meeting-minutes generation for the localhost notepad.
 * Mirrors Presence Studio's /api/voice/minutes prompt shape so downstream
 * consumers see the same structured keys.
 */
import { extractFirstJsonBlock } from '@agent/core/email-workflow';
import { getReasoningBackend } from '@agent/core/reasoning-backend';

export interface MeetingMinutesArtifact {
  title: string;
  summary: string;
  decisions: string[];
  action_items: string[];
  open_questions: string[];
  minutes_markdown: string;
}

export function toLineItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\n+/)
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

export function buildFallbackMinutesMarkdown(input: {
  title: string;
  summary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  sourceText: string;
}): string {
  const topSummary =
    input.summary.trim() ||
    input.sourceText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
  const sourcePreview = input.sourceText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n');
  return [
    `# ${input.title}`,
    '',
    '## Summary',
    topSummary || 'No summary available.',
    '',
    '## Decisions',
    ...(input.decisions.length ? input.decisions.map((item) => `- ${item}`) : ['- None captured.']),
    '',
    '## Action Items',
    ...(input.actionItems.length
      ? input.actionItems.map((item) => `- ${item}`)
      : ['- None captured.']),
    '',
    '## Open Questions',
    ...(input.openQuestions.length
      ? input.openQuestions.map((item) => `- ${item}`)
      : ['- None captured.']),
    '',
    '## Source Notes',
    sourcePreview || input.sourceText,
    '',
  ].join('\n');
}

export async function generateMeetingMinutes(input: {
  sourceText: string;
  title?: string;
  language?: string;
  attendees?: string[];
  attachmentNames?: string[];
  instruction?: string;
}): Promise<{ artifact: MeetingMinutesArtifact; backend: string; markdown: string }> {
  const title = input.title?.trim() || 'Meeting Minutes';
  const language = input.language?.trim() || 'ja';
  const attendees = input.attendees || [];
  const attachmentNames = input.attachmentNames || [];
  const instruction = input.instruction?.trim() || '';
  const sourceText = input.sourceText.trim();

  const backend = getReasoningBackend();
  let backendName = (backend as { name?: string })?.name || 'unknown';
  let artifact: MeetingMinutesArtifact | null = null;

  const prompt = [
    `You are converting meeting notes and transcripts into meeting minutes in ${language}.`,
    'Output ONLY a JSON object with keys: title, summary, decisions, action_items, open_questions, minutes_markdown.',
    'Keep the content concise, factual, and useful for follow-up.',
    'Do not invent facts that are not in the source notes or transcript.',
    `Title: ${title}`,
    attendees.length ? `Attendees: ${attendees.join(', ')}` : 'Attendees: not provided',
    attachmentNames.length
      ? `Attachments present (filenames only): ${attachmentNames.join(', ')}`
      : 'Attachments: none',
    instruction ? `Operator instruction: ${instruction}` : '',
    'Source notes / transcript:',
    sourceText || '(empty)',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const raw = await backend.delegateTask(prompt, `meeting-notepad-minutes:${Date.now()}`);
    backendName = (backend as { name?: string })?.name || backendName;
    const parsed = extractFirstJsonBlock(raw);
    if (parsed) {
      artifact = {
        title:
          typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : title,
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
        decisions: toLineItems(parsed.decisions),
        action_items: toLineItems(parsed.action_items),
        open_questions: toLineItems(parsed.open_questions),
        minutes_markdown:
          typeof parsed.minutes_markdown === 'string' ? parsed.minutes_markdown.trim() : '',
      };
    }
  } catch {
    artifact = null;
  }

  const minutes = artifact || {
    title,
    summary: sourceText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' '),
    decisions: [],
    action_items: [],
    open_questions: [],
    minutes_markdown: '',
  };
  const markdown =
    minutes.minutes_markdown.trim() ||
    buildFallbackMinutesMarkdown({
      title: minutes.title,
      summary: minutes.summary,
      decisions: minutes.decisions,
      actionItems: minutes.action_items,
      openQuestions: minutes.open_questions,
      sourceText,
    });

  return { artifact: { ...minutes, minutes_markdown: markdown }, backend: backendName, markdown };
}

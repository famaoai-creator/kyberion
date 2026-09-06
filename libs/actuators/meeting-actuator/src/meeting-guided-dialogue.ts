/**
 * Guided dialogue sessions: customer requirements hearing and gentle
 * tutoring. Both run in two phases through the same op so a mission can
 * drive multi-turn conversations without holding server-side state:
 *
 *   1. script/lesson — no `answers` yet: the model produces a tailored
 *      question script (hearing) or a sectioned gentle explanation with
 *      comprehension checks (tutoring).
 *   2. results/feedback — with `answers`: the model extracts structured
 *      requirements (hearing) or grades understanding kindly and fills
 *      gaps (tutoring).
 *
 * Reasoning goes through `delegateMeetingReasoning`, so mission-scoped
 * calls keep the canonical WorkItem governance of the other
 * intelligence ops. Pure prompt construction + zod-validated parsing
 * live here for unit tests; IO only writes `output_path` on request.
 */

import { z } from 'zod';
import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { getReasoningBackend } from '@agent/core/reasoning-backend';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { delegateMeetingReasoning } from './meeting-intelligence-ops.js';

type ReasoningBackendLike = ReturnType<typeof getReasoningBackend>;

const AnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

const HearingQuestionSchema = z.object({
  question: z.string(),
  purpose: z.string(),
  follow_ups: z.array(z.string()).optional(),
});

const RequirementSchema = z.object({
  id: z.string(),
  statement: z.string(),
  priority: z.enum(['must', 'should', 'could']).optional(),
  source_quote: z.string().optional(),
});

const HearingScriptSchema = z.object({
  questions: z.array(HearingQuestionSchema).min(1),
});

const HearingResultSchema = z.object({
  requirements: z.array(RequirementSchema),
  open_questions: z.array(z.string()),
  coverage_notes: z.string().optional(),
  next_questions: z.array(z.string()).optional(),
});

const TutorCheckSchema = z.object({
  question: z.string(),
  expected_points: z.array(z.string()).optional(),
});

const TutorSectionSchema = z.object({
  heading: z.string(),
  body: z.string(),
});

const TutorLessonSchema = z.object({
  sections: z.array(TutorSectionSchema).min(1),
  checks: z.array(TutorCheckSchema).min(1),
});

const TutorFeedbackSchema = z.object({
  mastery: z.enum(['struggling', 'progressing', 'solid']),
  feedback: z.string(),
  corrections: z.array(z.string()),
  follow_up: z.array(z.string()).optional(),
});

function parseModelJson(raw: string, schema: z.ZodTypeAny, op: string): any {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.search(/[\[{]/);
  if (start === -1) throw new Error(`[hearing] no JSON block in ${op} response`);
  const parsed = parseSafeJsonInput(candidate.slice(start), `${op} response`);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`[hearing] schema validation failed for "${op}": ${result.error.message}`);
  }
  return result.data;
}

function writeDialogueOutput(outputPath: string | undefined, data: unknown): string | undefined {
  if (!outputPath) return undefined;
  const abs = assertSafeRepositoryPath(pathResolver.rootResolve(outputPath), {
    allowMissingLeaf: true,
  });
  const dir = path.dirname(abs);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(abs, JSON.stringify(data, null, 2));
  return abs;
}

function languageNote(language?: string): string {
  const trimmed = String(language || '').trim();
  return trimmed ? `Respond in ${trimmed}.` : '';
}

export interface HearingSessionInput {
  topic: string;
  counterparty_label?: string;
  context?: string;
  answers?: Array<{ question: string; answer: string }>;
  mission_id?: string;
  work_item_id?: string;
  output_path?: string;
  language?: string;
}

export async function hearingSessionOp(
  input: HearingSessionInput,
  backend: ReasoningBackendLike = getReasoningBackend()
): Promise<Record<string, unknown>> {
  const topic = String(input.topic || '').trim();
  if (!topic) throw new Error('[hearing] topic is required');
  const answers = (Array.isArray(input.answers) ? input.answers : [])
    .map((entry) => AnswerSchema.safeParse(entry))
    .filter((parsed) => parsed.success)
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((entry) => entry.answer.trim());
  const who = String(input.counterparty_label || 'the customer').trim();
  const context = String(input.context || '').trim();
  const lang = languageNote(input.language);

  if (answers.length === 0) {
    const prompt = [
      `You are a senior requirements interviewer. Write an ordered hearing script for this topic: ${topic}.`,
      `Counterparty: ${who}.`,
      context ? `Background: ${context}` : '',
      'Rules: 5-8 open questions, each with a one-line purpose and 0-2 follow-ups.',
      'Start with easy facts, move to goals, then constraints and trade-offs.',
      'Output JSON only: { "questions": [ { "question", "purpose", "follow_ups"? } ] }. No fences, no commentary.',
      lang,
    ]
      .filter(Boolean)
      .join('\n');
    const raw = await delegateMeetingReasoning({
      backend,
      prompt,
      context: `hearing script for ${topic}`,
      ...(input.mission_id ? { mission_id: input.mission_id } : {}),
      ...(input.work_item_id ? { work_item_id: input.work_item_id } : {}),
      task_id: 'hearing-session',
    });
    const script = parseModelJson(raw, HearingScriptSchema, 'hearing-script');
    const written = writeDialogueOutput(input.output_path, {
      phase: 'script',
      topic,
      questions: script.questions,
    });
    return {
      phase: 'script',
      topic,
      questions: script.questions,
      ...(written ? { written_to: written } : {}),
    };
  }

  const transcript = answers
    .map((entry, index) => `Q${index + 1}: ${entry.question}\nA${index + 1}: ${entry.answer}`)
    .join('\n');
  const prompt = [
    `You are a senior requirements analyst. Extract structured requirements from this hearing about: ${topic}.`,
    `Counterparty: ${who}.`,
    context ? `Background: ${context}` : '',
    'Transcript:',
    transcript,
    'Rules: each requirement gets a stable id (R1, R2, …), a testable statement, and a priority.',
    'List what is still unclear as open_questions and suggest next_questions only when something material is missing.',
    'Output JSON only: { "requirements": [ { "id", "statement", "priority"?, "source_quote"? } ], "open_questions": [], "coverage_notes"?, "next_questions"? }. No fences, no commentary.',
    lang,
  ]
    .filter(Boolean)
    .join('\n');
  const raw = await delegateMeetingReasoning({
    backend,
    prompt,
    context: `hearing results for ${topic}`,
    ...(input.mission_id ? { mission_id: input.mission_id } : {}),
    ...(input.work_item_id ? { work_item_id: input.work_item_id } : {}),
    task_id: 'hearing-session',
  });
  const result = parseModelJson(raw, HearingResultSchema, 'hearing-results');
  const written = writeDialogueOutput(input.output_path, {
    phase: 'results',
    topic,
    ...result,
  });
  return {
    phase: 'results',
    topic,
    ...result,
    ...(written ? { written_to: written } : {}),
  };
}

export interface TutorSessionInput {
  material: string;
  learner_label?: string;
  goal?: string;
  answers?: Array<{ question: string; answer: string }>;
  mission_id?: string;
  work_item_id?: string;
  output_path?: string;
  language?: string;
}

export async function tutorSessionOp(
  input: TutorSessionInput,
  backend: ReasoningBackendLike = getReasoningBackend()
): Promise<Record<string, unknown>> {
  const material = String(input.material || '').trim();
  if (!material) throw new Error('[tutor] material is required');
  const answers = (Array.isArray(input.answers) ? input.answers : [])
    .map((entry) => AnswerSchema.safeParse(entry))
    .filter((parsed) => parsed.success)
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((entry) => entry.answer.trim());
  const learner = String(input.learner_label || 'the learner').trim();
  const goal = String(input.goal || '').trim();
  const lang = languageNote(input.language);

  if (answers.length === 0) {
    const prompt = [
      `You are a kind, patient tutor explaining learning material to ${learner}.`,
      goal ? `Learning goal: ${goal}.` : '',
      'Material:',
      material,
      'Rules: explain gently in 3-5 short sections with everyday analogies; never condescend, never skip the why.',
      'End with 2-4 comprehension check questions (with expected key points each).',
      'Output JSON only: { "sections": [ { "heading", "body" } ], "checks": [ { "question", "expected_points"? } ] }. No fences, no commentary.',
      lang,
    ]
      .filter(Boolean)
      .join('\n');
    const raw = await delegateMeetingReasoning({
      backend,
      prompt,
      context: 'tutor lesson',
      ...(input.mission_id ? { mission_id: input.mission_id } : {}),
      ...(input.work_item_id ? { work_item_id: input.work_item_id } : {}),
      task_id: 'tutor-session',
    });
    const lesson = parseModelJson(raw, TutorLessonSchema, 'tutor-lesson');
    const written = writeDialogueOutput(input.output_path, {
      phase: 'lesson',
      ...lesson,
    });
    return {
      phase: 'lesson',
      ...lesson,
      ...(written ? { written_to: written } : {}),
    };
  }

  const transcript = answers
    .map((entry, index) => `Q${index + 1}: ${entry.question}\nA${index + 1}: ${entry.answer}`)
    .join('\n');
  const prompt = [
    `You are a kind, patient tutor reviewing ${learner}'s answers.`,
    goal ? `Learning goal: ${goal}.` : '',
    'Material:',
    material,
    'Answers:',
    transcript,
    'Rules: praise what is right first, correct mistakes gently with the right idea restated simply, rate mastery honestly (struggling|progressing|solid), and suggest concrete follow-up steps.',
    'Output JSON only: { "mastery", "feedback", "corrections": [], "follow_up"? }. No fences, no commentary.',
    lang,
  ]
    .filter(Boolean)
    .join('\n');
  const raw = await delegateMeetingReasoning({
    backend,
    prompt,
    context: 'tutor feedback',
    ...(input.mission_id ? { mission_id: input.mission_id } : {}),
    ...(input.work_item_id ? { work_item_id: input.work_item_id } : {}),
    task_id: 'tutor-session',
  });
  const feedback = parseModelJson(raw, TutorFeedbackSchema, 'tutor-feedback');
  const written = writeDialogueOutput(input.output_path, {
    phase: 'feedback',
    ...feedback,
  });
  return {
    phase: 'feedback',
    ...feedback,
    ...(written ? { written_to: written } : {}),
  };
}

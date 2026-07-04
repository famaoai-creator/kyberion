import { z } from 'zod';

import type {
  A2ATaskContract,
  A2ATaskContext,
  PlanningPacket,
  PlanningPacketTask,
  TaskResultBlock,
  TaskResultArtifact,
} from './channel-surface-types.js';

export const PlanningPacketTaskSchema: z.ZodType<PlanningPacketTask> = z
  .object({
    task_id: z.string().min(1),
    team_role: z.string().min(1),
    description: z.string().min(1),
    deliverable: z.string().optional(),
    target_path: z.string().optional(),
    dependencies: z.array(z.string().min(1)).optional(),
    acceptance_criteria: z.array(z.string().min(1)).optional(),
    risk: z.enum(['low', 'medium', 'high', 'approval_required', 'high_stakes']).optional(),
    expected_output_format: z.enum(['text', 'files', 'structured']).optional(),
    estimated_scope: z.enum(['S', 'M', 'L']).optional(),
  })
  .strict();

export const PlanningPacketSchema: z.ZodType<PlanningPacket> = z
  .object({
    mission_id: z.string().optional(),
    summary: z.string().optional(),
    plan_markdown: z.string().min(1),
    next_tasks: z.array(PlanningPacketTaskSchema).min(1),
  })
  .strict();

export const TaskResultArtifactSchema: z.ZodType<TaskResultArtifact> = z
  .object({
    path: z.string().min(1),
    kind: z.string().min(1),
  })
  .strict();

export const TaskResultSchema: z.ZodType<TaskResultBlock> = z
  .object({
    summary: z.string().min(1).max(800),
    artifacts: z.array(TaskResultArtifactSchema),
    verification_done: z.array(z.string().min(1)),
    gaps: z.array(z.string().min(1)),
    needs: z.array(z.string().min(1)),
  })
  .strict();

export const A2ATaskContextSchema: z.ZodType<A2ATaskContext> = z
  .object({
    mission_id: z.string().min(1),
    team_role: z.string().min(1),
    execution_mode: z.string().optional(),
    channel: z.string().optional(),
    thread: z.string().optional(),
    slack_channel: z.string().optional(),
    correlation_id: z.string().optional(),
    user_language: z.string().optional(),
    task_model_hint: z.record(z.string(), z.unknown()).optional(),
    model_hint: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const A2ATaskContractSchema: z.ZodType<A2ATaskContract> = z
  .object({
    intent: z.string().min(1),
    text: z.string().min(1),
    context: A2ATaskContextSchema,
    task_model_hint: z.record(z.string(), z.unknown()).optional(),
    objective: z.string().optional(),
    acceptance_criteria: z.array(z.string().min(1)).optional(),
    expected_outputs: z.array(z.string().min(1)).optional(),
    rationale: z.string().optional(),
    prior_decisions: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ProcedureRankingCandidateSchema = z
  .object({
    procedure_id: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
  })
  .strict();

export interface ProcedureRankingCandidate {
  procedure_id: string;
  confidence: number;
  reason: string;
}

export interface ProcedureRankingResult {
  candidates: ProcedureRankingCandidate[];
}

export const PlanningReviewVerdictSchema = z
  .object({
    approve: z.boolean(),
    gaps: z.array(z.string().min(1)).default([]),
    rationale: z.string().optional(),
  })
  .strict();

export interface PlanningReviewVerdictResult {
  approve: boolean;
  gaps: string[];
  rationale?: string;
}

export const ProcedureRankingSchema = z
  .object({
    candidates: z.array(ProcedureRankingCandidateSchema),
  })
  .strict();

export const structuredOutputSchemas = {
  planning_packet: PlanningPacketSchema,
  task_result: TaskResultSchema,
  planning_review_verdict: PlanningReviewVerdictSchema,
  a2a_task_contract: A2ATaskContractSchema,
  procedure_ranking: ProcedureRankingSchema,
} as const;

export type StructuredOutputSchemaName = keyof typeof structuredOutputSchemas;

export type StructuredOutputSchemaRef<T = unknown> =
  | z.ZodType<T>
  | StructuredOutputSchemaName;

export function resolveStructuredOutputSchema<T>(
  schema: StructuredOutputSchemaRef<T>
): z.ZodType<T> {
  if (typeof schema !== 'string') {
    return schema;
  }
  const resolved = structuredOutputSchemas[schema];
  if (!resolved) {
    throw new Error(`Unknown structured output schema: ${schema}`);
  }
  return resolved as z.ZodType<T>;
}

export function renderStructuredOutputSchemaPrompt<T>(
  schema: StructuredOutputSchemaRef<T>
): string {
  const resolved = resolveStructuredOutputSchema(schema);
  const schemaJson = z.toJSONSchema(resolved) as Record<string, unknown>;
  if ('$schema' in schemaJson) delete schemaJson['$schema'];
  return JSON.stringify(schemaJson, null, 2);
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `/${issue.path.map(String).join('/')}` : '/';
    return `${path} ${issue.message || 'schema violation'}`.trim();
  });
}

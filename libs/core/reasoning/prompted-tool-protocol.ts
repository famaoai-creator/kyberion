/**
 * Prompted tool-calling protocol — lets a text-only provider (a local CLI with
 * its own tools disabled) take part in Kyberion's single-turn
 * `generateWithTools` contract.
 *
 * The provider never executes anything. {@link renderPromptedToolProtocol}
 * describes the tools (name, description, JSON schema) in the prompt and asks
 * for exactly one of two reply forms: a plain final answer, or one fenced JSON
 * block `{"tool_calls":[{"name":...,"input":{...}}]}`.
 * {@link parsePromptedToolResponse} turns the reply back into a
 * {@link GenerateWithToolsResult}; Kyberion's goal driver then executes the
 * accepted calls itself.
 *
 * Fail-closed parsing: a call naming an unknown tool, or whose input does not
 * validate against that tool's schema, is rejected (never returned as a tool
 * call); malformed JSON yields the reply as text with no tool calls.
 */

import type { ValidateFunction } from 'ajv';
import { createAjv } from '../foundation/ajv.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import type {
  GenerateWithToolsResult,
  ToolCall,
  ToolDefinition,
} from './reasoning-backend-contracts.js';

export const PROMPTED_TOOL_CALLS_KEY = 'tool_calls';

export interface PromptedToolRejection {
  name: string;
  reason: string;
}

export interface PromptedToolParseOutcome {
  result: GenerateWithToolsResult;
  /** Calls the provider asked for that were refused (never executed). */
  rejected: PromptedToolRejection[];
  /** A tool-call block was present but could not be parsed as JSON. */
  malformed: boolean;
}

/** Render the caller prompt plus the tool catalog and the strict reply contract. */
export function renderPromptedToolProtocol(
  prompt: string,
  tools: readonly ToolDefinition[]
): string {
  const catalog = tools.map((tool) =>
    [
      `- name: ${tool.name}`,
      `  description: ${tool.description.replace(/\s+/g, ' ').trim()}`,
      `  input_schema: ${JSON.stringify(tool.inputSchema)}`,
    ].join('\n')
  );
  return [
    prompt,
    '',
    '## Tool-calling protocol',
    'You cannot run tools yourself. The host runs the tools you request and reports',
    'their results in a later message. Never invent a tool result.',
    '',
    'Available tools:',
    ...(catalog.length > 0 ? catalog : ['- (none)']),
    '',
    'Reply in exactly ONE of these two forms:',
    '1. Final answer: plain text only, with no fenced JSON block.',
    '2. Tool request: exactly one fenced JSON block, in this shape:',
    '```json',
    `{"${PROMPTED_TOOL_CALLS_KEY}":[{"name":"<tool name>","input":{}}]}`,
    '```',
    'Rules for a tool request: use only the tool names listed above; each "input"',
    "must be a JSON object that satisfies that tool's input_schema; you may request",
    'several calls in the one block; put no other JSON block in the reply.',
  ].join('\n');
}

const FENCED_BLOCK = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;

interface ToolBlock {
  /** Start/end offsets in the raw reply, so the surrounding prose is kept. */
  start: number;
  end: number;
  body: string;
}

function findToolBlock(raw: string): ToolBlock | null {
  for (const match of raw.matchAll(FENCED_BLOCK)) {
    const body = match[2] ?? '';
    if (!body.includes(PROMPTED_TOOL_CALLS_KEY)) continue;
    const start = match.index ?? 0;
    return { start, end: start + match[0].length, body };
  }
  const trimmed = raw.trim();
  // A bare (unfenced) JSON object is accepted only when it is the whole reply.
  if (
    trimmed.startsWith('{') &&
    trimmed.endsWith('}') &&
    trimmed.includes(PROMPTED_TOOL_CALLS_KEY)
  ) {
    return { start: 0, end: raw.length, body: trimmed };
  }
  return null;
}

const validatorCache = new WeakMap<object, ValidateFunction | null>();
let sharedAjv: ReturnType<typeof createAjv> | null = null;

function validatorFor(tool: ToolDefinition): ValidateFunction | null {
  const schema = tool.inputSchema as object;
  if (validatorCache.has(schema)) return validatorCache.get(schema) ?? null;
  let compiled: ValidateFunction | null = null;
  try {
    // Tool schemas are model-facing and may carry annotation keywords the
    // strict governance compiler would reject; validate them non-strictly.
    sharedAjv ??= createAjv({ strict: false, allErrors: true });
    compiled = sharedAjv.compile(schema);
  } catch {
    compiled = null;
  }
  validatorCache.set(schema, compiled);
  return compiled;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectionNote(rejected: readonly PromptedToolRejection[]): string {
  return rejected
    .map((entry) => `[prompted-tool-protocol] refused tool call "${entry.name}": ${entry.reason}`)
    .join('\n');
}

/**
 * Parse a provider reply produced under {@link renderPromptedToolProtocol}.
 * Only calls naming a declared tool with a schema-valid object input are
 * returned as `toolCalls`; refusals are reported in `rejected` and appended to
 * `text` so the next turn can see why nothing ran.
 */
export function parsePromptedToolResponse(
  raw: string,
  tools: readonly ToolDefinition[]
): PromptedToolParseOutcome {
  const reply = String(raw ?? '');
  const block = findToolBlock(reply);
  if (!block) {
    const text = reply.trim();
    return { result: text ? { text } : {}, rejected: [], malformed: false };
  }

  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(block.body.trim(), 'prompted tool-call block');
  } catch {
    const text = reply.trim();
    return { result: text ? { text } : {}, rejected: [], malformed: true };
  }
  const calls = isPlainObject(parsed) ? parsed[PROMPTED_TOOL_CALLS_KEY] : undefined;
  if (!Array.isArray(calls)) {
    const text = reply.trim();
    return { result: text ? { text } : {}, rejected: [], malformed: true };
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const accepted: ToolCall[] = [];
  const rejected: PromptedToolRejection[] = [];
  for (const entry of calls) {
    const name = isPlainObject(entry) && typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      rejected.push({ name: '(unnamed)', reason: 'call has no tool name' });
      continue;
    }
    const tool = byName.get(name);
    if (!tool) {
      rejected.push({ name, reason: 'unknown tool' });
      continue;
    }
    const input = (entry as Record<string, unknown>).input ?? {};
    if (!isPlainObject(input)) {
      rejected.push({ name, reason: 'input is not a JSON object' });
      continue;
    }
    const validate = validatorFor(tool);
    if (!validate) {
      rejected.push({ name, reason: 'tool input schema could not be compiled' });
      continue;
    }
    if (!validate(input)) {
      const detail = (validate.errors ?? [])
        .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
        .join('; ');
      rejected.push({ name, reason: `input does not match schema (${detail || 'invalid'})` });
      continue;
    }
    accepted.push({ name, input });
  }

  const prose = `${reply.slice(0, block.start)}${reply.slice(block.end)}`.trim();
  const text = [prose, rejected.length > 0 ? rejectionNote(rejected) : '']
    .filter(Boolean)
    .join('\n\n');
  return {
    result: {
      ...(text ? { text } : {}),
      ...(accepted.length > 0 ? { toolCalls: accepted } : {}),
    },
    rejected,
    malformed: false,
  };
}

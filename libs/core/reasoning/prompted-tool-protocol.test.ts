import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from './reasoning-backend-contracts.js';
import { parsePromptedToolResponse, renderPromptedToolProtocol } from './prompted-tool-protocol.js';

const tools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a governed file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'goal_update',
    description: 'Report goal status.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['continue', 'complete', 'blocked'] } },
      required: ['status'],
    },
  },
];

const fence = (body: string) => ['```json', body, '```'].join('\n');

describe('renderPromptedToolProtocol', () => {
  it('keeps the prompt and lists every tool with its schema and the reply contract', () => {
    const rendered = renderPromptedToolProtocol('Do the task.', tools);
    expect(rendered.startsWith('Do the task.')).toBe(true);
    expect(rendered).toContain('- name: read_file');
    expect(rendered).toContain(JSON.stringify(tools[0]!.inputSchema));
    expect(rendered).toContain('- name: goal_update');
    expect(rendered).toContain('{"tool_calls":[{"name":"<tool name>","input":{}}]}');
    expect(rendered).toContain('You cannot run tools yourself');
  });
});

describe('parsePromptedToolResponse', () => {
  it('parses a fenced tool-call block into toolCalls and keeps the prose', () => {
    const raw = `Reading first.\n${fence('{"tool_calls":[{"name":"read_file","input":{"path":"a.md"}},{"name":"goal_update","input":{"status":"continue"}}]}')}`;
    const outcome = parsePromptedToolResponse(raw, tools);
    expect(outcome.result.toolCalls).toEqual([
      { name: 'read_file', input: { path: 'a.md' } },
      { name: 'goal_update', input: { status: 'continue' } },
    ]);
    expect(outcome.result.text).toBe('Reading first.');
    expect(outcome.rejected).toEqual([]);
  });

  it('accepts a bare JSON reply that is only the tool-call object', () => {
    const outcome = parsePromptedToolResponse(
      '{"tool_calls":[{"name":"read_file","input":{"path":"b"}}]}',
      tools
    );
    expect(outcome.result).toEqual({ toolCalls: [{ name: 'read_file', input: { path: 'b' } }] });
  });

  it('returns a final answer as text with no toolCalls', () => {
    const outcome = parsePromptedToolResponse('  All done, nothing else to run.  ', tools);
    expect(outcome.result).toEqual({ text: 'All done, nothing else to run.' });
    expect(outcome.malformed).toBe(false);
  });

  it('returns malformed JSON as text with no toolCalls', () => {
    const raw = fence('{"tool_calls":[{"name":"read_file","input":{"path":');
    const outcome = parsePromptedToolResponse(raw, tools);
    expect(outcome.result.toolCalls).toBeUndefined();
    expect(outcome.result.text).toBe(raw);
    expect(outcome.malformed).toBe(true);
  });

  it('rejects an unknown tool name and never returns it as a call', () => {
    const outcome = parsePromptedToolResponse(
      fence(
        '{"tool_calls":[{"name":"rm_rf","input":{}},{"name":"read_file","input":{"path":"ok"}}]}'
      ),
      tools
    );
    expect(outcome.result.toolCalls).toEqual([{ name: 'read_file', input: { path: 'ok' } }]);
    expect(outcome.rejected).toEqual([{ name: 'rm_rf', reason: 'unknown tool' }]);
    expect(outcome.result.text).toContain('refused tool call "rm_rf"');
  });

  it('rejects schema-invalid inputs (missing required, wrong type, enum, non-object)', () => {
    const outcome = parsePromptedToolResponse(
      fence(
        JSON.stringify({
          tool_calls: [
            { name: 'read_file', input: {} },
            { name: 'read_file', input: { path: 42 } },
            { name: 'goal_update', input: { status: 'finished' } },
            { name: 'read_file', input: 'a.md' },
          ],
        })
      ),
      tools
    );
    expect(outcome.result.toolCalls).toBeUndefined();
    expect(outcome.rejected).toHaveLength(4);
    expect(outcome.rejected.map((entry) => entry.name)).toEqual([
      'read_file',
      'read_file',
      'goal_update',
      'read_file',
    ]);
    expect(outcome.rejected[3]!.reason).toBe('input is not a JSON object');
  });

  it('rejects prototype-polluting payloads as malformed', () => {
    const outcome = parsePromptedToolResponse(
      fence('{"tool_calls":[{"name":"read_file","input":{"__proto__":{"x":1},"path":"a"}}]}'),
      tools
    );
    expect(outcome.result.toolCalls).toBeUndefined();
    expect(outcome.malformed).toBe(true);
  });
});

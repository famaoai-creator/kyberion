import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile, safeRmSync } from './secure-io.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { compileUserIntentFlow } from './intent-contract.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('japanese-contextual-intent corpus', () => {
  const corpusPath = pathResolver.knowledge('product/governance/japanese-contextual-intent-corpus.json');
  const schemaPath = pathResolver.knowledge('product/schemas/japanese-contextual-intent-corpus.schema.json');
  const memoryPath = pathResolver.shared('runtime/test-contextual-intent-memory.json');

  it('matches the schema and covers the contextual intent regression set', async () => {
    process.env.KYBERION_CONTEXTUAL_INTENT_MEMORY_PATH = memoryPath;
    safeRmSync(memoryPath);

    const corpus = JSON.parse(safeReadFile(corpusPath, { encoding: 'utf8' }) as string);
    const validate = compileSchemaFromPath(new Ajv({ allErrors: true }), schemaPath);
    expect(validate(corpus), JSON.stringify(validate.errors || [])).toBe(true);
    expect(corpus.items).toHaveLength(50);

    const byId = new Map(corpus.items.map((item: any) => [item.id, item]));
    const cases = [
      {
        id: 'JA-INTENT-001',
        expected: {
          check_packet: true,
          frame: {
            action: 'read',
            object: 'calendar_events',
            subject: 'operator_self',
            date_range: 'next_week',
            source_binding: 'browser_calendar',
          },
          route: {
            intent_id: 'schedule-read-agenda',
            execution_shape: 'direct_reply',
            result_shape: 'calendar_agenda_summary',
          },
          clarification_needed: false,
        },
      },
      {
        id: 'JA-INTENT-017',
        expected: {
          check_packet: true,
          frame: {
            action: 'read',
            object: 'calendar_events',
            subject: 'operator_self',
            date_range: 'next_week',
            source_binding: 'google_calendar',
          },
          route: {
            intent_id: 'schedule-read-agenda',
            execution_shape: 'direct_reply',
            result_shape: 'calendar_agenda_summary',
          },
          clarification_needed: false,
        },
      },
      {
        id: 'JA-INTENT-031',
        expected: {
          check_packet: false,
          frame: {
            action: 'change',
            object: 'calendar_schedule',
            subject: 'operator_self',
          },
          route: {
            intent_id: 'schedule-coordination',
            execution_shape: 'task_session',
            result_shape: 'summary',
          },
          clarification_needed: true,
        },
      },
      {
        id: 'JA-INTENT-045',
        expected: {
          check_packet: false,
          frame: {
            action: 'change',
            object: 'calendar_schedule',
            subject: 'team',
          },
          route: {
            intent_id: 'schedule-coordination',
            execution_shape: 'task_session',
            result_shape: 'summary',
          },
          clarification_needed: true,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const item = byId.get(testCase.id);
      expect(item, `missing corpus item ${testCase.id}`).toBeTruthy();
      const frame = buildContextualIntentFrame(item!.utterance);
      const packet = resolveIntentResolutionPacket(item!.utterance);
      const flow = await compileUserIntentFlow(
        { text: item!.utterance },
        { askFn: async () => 'not json' }
      );

      expect(frame.action).toBe(testCase.expected.frame.action);
      expect(frame.object).toBe(testCase.expected.frame.object);
      expect(frame.subject).toBe(testCase.expected.frame.subject);
      if ('date_range' in testCase.expected.frame) {
        expect(frame.date_range?.value).toBe(testCase.expected.frame.date_range);
      }
      if ('source_binding' in testCase.expected.frame) {
        expect(frame.source_binding.selected).toBe(testCase.expected.frame.source_binding);
      }

      if (testCase.expected.check_packet) {
        expect(packet.selected_intent_id).toBe(testCase.expected.route.intent_id);
        expect(packet.selected_resolution?.shape).toBe(testCase.expected.route.execution_shape);
        expect(packet.selected_resolution?.result_shape).toBe(testCase.expected.route.result_shape);
      }
      expect(flow.intentContract.intent_id).toBe(testCase.expected.route.intent_id);
      expect(flow.intentContract.resolution.execution_shape).toBe(
        testCase.expected.route.execution_shape
      );
      expect(flow.intentContract.outcome_ids[0]).toBe(
        testCase.expected.route.result_shape === 'calendar_agenda_summary'
          ? 'calendar_agenda_summary'
          : 'schedule_coordination_summary'
      );
      expect(flow.intentContract.clarification_needed).toBe(testCase.expected.clarification_needed);
    }
  });
});

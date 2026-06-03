import AjvModule from 'ajv';
import { compileSchemaFromPath, pathResolver } from '@agent/core';
import {
  buildContextualIntentFrame,
  compileUserIntentFlow,
  resolveIntentResolutionPacket,
} from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

type CorpusItem = {
  id: string;
  utterance: string;
  expected_frame: {
    action: 'read' | 'change' | 'unknown';
    object: 'calendar_events' | 'calendar_schedule' | 'unknown';
    subject: 'operator_self' | 'team' | 'unknown';
    date_range?: 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'this_month' | 'next_month' | 'custom';
    source_binding?: 'operator_default_calendar' | 'google_calendar' | 'outlook_calendar' | 'browser_calendar';
  };
  expected_route: {
    intent_id: string;
    execution_shape: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
    result_shape: string;
  };
  clarification_needed: boolean;
};

type CorpusFile = {
  version: string;
  locale: string;
  description?: string;
  items: CorpusItem[];
};

function compareExpectedFrame(
  actual: ReturnType<typeof buildContextualIntentFrame>,
  expected: CorpusItem['expected_frame']
): string[] {
  const failures: string[] = [];
  if (actual.action !== expected.action) failures.push(`action expected ${expected.action}, got ${actual.action}`);
  if (actual.object !== expected.object) failures.push(`object expected ${expected.object}, got ${actual.object}`);
  if (actual.subject !== expected.subject) failures.push(`subject expected ${expected.subject}, got ${actual.subject}`);
  if (expected.date_range && actual.date_range?.value !== expected.date_range) {
    failures.push(`date_range expected ${expected.date_range}, got ${actual.date_range?.value || 'missing'}`);
  }
  if (expected.source_binding && actual.source_binding.selected !== expected.source_binding) {
    failures.push(
      `source_binding expected ${expected.source_binding}, got ${actual.source_binding.selected || 'missing'}`
    );
  }
  return failures;
}

async function main(): Promise<void> {
  const corpusPath = pathResolver.knowledge('product/governance/japanese-contextual-intent-corpus.json');
  const schemaPath = pathResolver.knowledge('product/schemas/japanese-contextual-intent-corpus.schema.json');
  const corpus = readJsonFile<CorpusFile>(corpusPath);
  const validate = compileSchemaFromPath(ajv, schemaPath);

  if (!validate(corpus)) {
    console.error('[eval:japanese-contextual-intent] invalid corpus schema');
    console.error((validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('\n'));
    process.exit(1);
  }

  const failures: string[] = [];
  let routeHits = 0;
  let askHits = 0;
  let frameHits = 0;

  for (const item of corpus.items) {
    const frame = buildContextualIntentFrame(item.utterance);
    const packet = resolveIntentResolutionPacket(item.utterance);
    const flow = await compileUserIntentFlow(
      { text: item.utterance },
      { askFn: async () => 'not json' }
    );

    const frameFailures = compareExpectedFrame(frame, item.expected_frame);
    if (frameFailures.length === 0) frameHits += 1;
    else failures.push(`${item.id}: frame mismatch -> ${frameFailures.join('; ')}`);

    const routeFailures: string[] = [];
    if (packet.selected_intent_id !== item.expected_route.intent_id) {
      routeFailures.push(`intent expected ${item.expected_route.intent_id}, got ${packet.selected_intent_id || 'missing'}`);
    }
    if (packet.selected_resolution?.shape !== item.expected_route.execution_shape) {
      routeFailures.push(
        `execution_shape expected ${item.expected_route.execution_shape}, got ${packet.selected_resolution?.shape || 'missing'}`
      );
    }
    if ((packet.selected_resolution?.result_shape || '') !== item.expected_route.result_shape) {
      routeFailures.push(
        `result_shape expected ${item.expected_route.result_shape}, got ${packet.selected_resolution?.result_shape || 'missing'}`
      );
    }
    if (routeFailures.length === 0) routeHits += 1;
    else failures.push(`${item.id}: route mismatch -> ${routeFailures.join('; ')}`);

    if (flow.intentContract.clarification_needed === item.clarification_needed) {
      askHits += 1;
    } else {
      failures.push(
        `${item.id}: clarification expected ${item.clarification_needed}, got ${flow.intentContract.clarification_needed}`
      );
    }
  }

  const total = corpus.items.length;
  const report = {
    corpus: corpusPath,
    total,
    frame_accuracy: Number((frameHits / total).toFixed(4)),
    route_accuracy: Number((routeHits / total).toFixed(4)),
    ask_vs_act_accuracy: Number((askHits / total).toFixed(4)),
    failures: failures.slice(0, 20),
  };

  console.log(JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    console.error(`[eval:japanese-contextual-intent] completed with ${failures.length} mismatches`);
    return;
  }

  console.log('[eval:japanese-contextual-intent] OK');
}

main().catch((error) => {
  console.error('[eval:japanese-contextual-intent] UNCAUGHT ERROR');
  console.error(error);
  process.exit(1);
});

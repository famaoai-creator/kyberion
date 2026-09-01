import { pathResolver } from '@agent/core/path-resolver';
import { defineCatalog } from '@agent/core/foundation';
import { buildContextualIntentFrame } from '@agent/core/contextual-intent-frame';
import { compileUserIntentFlow } from '@agent/core/intent-contract';
import { resolveIntentResolutionPacket } from '@agent/core/intent-resolution';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type CorpusItem = {
  id: string;
  utterance: string;
  expected_frame: {
    action: 'read' | 'change' | 'unknown';
    object: 'calendar_events' | 'calendar_schedule' | 'unknown';
    subject: 'operator_self' | 'team' | 'unknown';
    date_range?:
      'today' | 'tomorrow' | 'this_week' | 'next_week' | 'this_month' | 'next_month' | 'custom';
    source_binding?:
      'operator_default_calendar' | 'google_calendar' | 'outlook_calendar' | 'browser_calendar';
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
  if (actual.action !== expected.action)
    failures.push(`action expected ${expected.action}, got ${actual.action}`);
  if (actual.object !== expected.object)
    failures.push(`object expected ${expected.object}, got ${actual.object}`);
  if (actual.subject !== expected.subject)
    failures.push(`subject expected ${expected.subject}, got ${actual.subject}`);
  if (expected.date_range && actual.date_range?.value !== expected.date_range) {
    failures.push(
      `date_range expected ${expected.date_range}, got ${actual.date_range?.value || 'missing'}`
    );
  }
  if (expected.source_binding && actual.source_binding.selected !== expected.source_binding) {
    failures.push(
      `source_binding expected ${expected.source_binding}, got ${actual.source_binding.selected || 'missing'}`
    );
  }
  return failures;
}

type EvaluationReport = {
  corpus: string;
  total: number;
  frame_accuracy: number;
  route_accuracy: number;
  ask_vs_act_accuracy: number;
  failures: string[];
};

type EvaluationResult = {
  report: EvaluationReport;
  mismatchCount: number;
};

export async function main(): Promise<EvaluationResult> {
  const corpusPath = pathResolver.knowledge(
    'product/governance/japanese-contextual-intent-corpus.json'
  );
  const schemaPath = pathResolver.knowledge(
    'product/schemas/japanese-contextual-intent-corpus.schema.json'
  );
  let corpus: CorpusFile;
  try {
    corpus = defineCatalog<CorpusFile>({
      id: 'japanese-contextual-intent-corpus',
      path: corpusPath,
      schema: schemaPath,
    }).load();
  } catch (error) {
    throw new ScriptExitError(
      1,
      `[eval:japanese-contextual-intent] invalid corpus schema: ${String(error)}`
    );
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
      routeFailures.push(
        `intent expected ${item.expected_route.intent_id}, got ${packet.selected_intent_id || 'missing'}`
      );
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

  return { report, mismatchCount: failures.length };
}

export const runJapaneseContextualIntentEval = defineScript({
  name: 'eval:japanese-contextual-intent',
  flags: [],
  run: async (context) => {
    const { report, mismatchCount } = await main();
    context.print(report);
    if (mismatchCount > 0) {
      throw new ScriptExitError(
        1,
        `[eval:japanese-contextual-intent] completed with ${mismatchCount} mismatches`
      );
    }
    context.print('[eval:japanese-contextual-intent] OK');
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'eval_japanese_contextual_intent.ts') ||
  isDirectScript(import.meta.url, 'eval_japanese_contextual_intent.js')
)
  void runJapaneseContextualIntentEval();

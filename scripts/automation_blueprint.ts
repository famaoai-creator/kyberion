/**
 * HA-03 Automation Blueprint preview/resolution CLI.
 *
 * This command is intentionally dry-run only: it derives the shared slot
 * schema and resolved schedule but never writes a pipeline or registers a
 * schedule. A governed creation surface can consume the same JSON contract.
 */

import {
  buildAutomationFormSchema,
  buildAutomationQuestionSeed,
  buildAutomationSlashCommand,
  listAutomationBlueprintCatalog,
  loadAutomationBlueprint,
  resolveAutomationBlueprint,
} from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

function flag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
}

function usage(): never {
  throw new Error(
    'Usage: pnpm automation:blueprint <list|render> [--pipeline pipelines/<file>.json] [--values-json <json>]'
  );
}

function blueprintFor(ref: string) {
  return loadAutomationBlueprint(ref).blueprint;
}

function render(ref: string, valuesJson: string) {
  const blueprint = blueprintFor(ref);
  const values = valuesJson ? (JSON.parse(valuesJson) as Record<string, unknown>) : undefined;
  return {
    blueprint,
    question_seed: buildAutomationQuestionSeed(blueprint),
    slash_command: buildAutomationSlashCommand(blueprint),
    form: buildAutomationFormSchema(blueprint),
    ...(values ? { resolved: resolveAutomationBlueprint(blueprint, values) } : {}),
  };
}

export const main = defineScript({
  name: 'automation:blueprint',
  flags: [],
  run(context) {
    const argv = context.positional;
    const command = argv[0];
    if (!command) usage();

    if (command === 'list') {
      const blueprints = listAutomationBlueprintCatalog().map(({ blueprint }) => ({
        blueprint_id: blueprint.blueprint_id,
        name: blueprint.name,
        pipeline_ref: blueprint.pipeline_ref,
      }));
      context.print({ blueprints });
      return;
    }

    if (command !== 'render') usage();
    const ref = flag(argv, '--pipeline');
    if (!ref) usage();
    context.print(render(ref, flag(argv, '--values-json')));
  },
});

if (
  isDirectScript(import.meta.url, 'automation_blueprint.ts') ||
  isDirectScript(import.meta.url, 'automation_blueprint.js')
) {
  void main();
}

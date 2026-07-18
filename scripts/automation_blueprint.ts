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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command) usage();

  if (command === 'list') {
    const blueprints = listAutomationBlueprintCatalog().map(({ blueprint }) => ({
      blueprint_id: blueprint.blueprint_id,
      name: blueprint.name,
      pipeline_ref: blueprint.pipeline_ref,
    }));
    process.stdout.write(`${JSON.stringify({ blueprints }, null, 2)}\n`);
    return;
  }

  if (command !== 'render') usage();
  const ref = flag(argv, '--pipeline');
  if (!ref) usage();
  process.stdout.write(`${JSON.stringify(render(ref, flag(argv, '--values-json')), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

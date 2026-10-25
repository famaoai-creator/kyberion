#!/usr/bin/env node
/**
 * Governed design-spec tool for delegated workers.
 *
 * Workers may not write mission evidence directly. Instead they stage a
 * payload under `active/shared/tmp/` and call this script, which validates the
 * JSON through the canonical schema and saves it through the governed
 * `saveDesignSpec()` facade, then reports the ARCHITECTURE_READY gate result.
 *
 * Usage:
 *   node --import ./scripts/ts-loader.mjs scripts/design_spec.ts save \
 *     --mission <MISSION_ID> --project-name <name> --file <payload.json> --by <work-item-id>
 *   node --import ./scripts/ts-loader.mjs scripts/design_spec.ts show --mission <MISSION_ID>
 *   node --import ./scripts/ts-loader.mjs scripts/design_spec.ts gate --mission <MISSION_ID>
 */
import * as path from 'node:path';
import {
  saveDesignSpec,
  readDesignSpec,
  evaluateArchitectureReadyGate,
} from '@agent/core/sdlc-artifact-store';
import { safeReadFileSnapshot, safeExistsSync } from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { findMissionPath } from '@agent/core/path-resolver';

type ExtractedDesignSpec = Parameters<typeof saveDesignSpec>[0]['extracted'];

interface Args {
  command?: string;
  mission?: string;
  projectName?: string;
  file?: string;
  by?: string;
  [k: string]: unknown;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  const [command, ...rest] = argv;
  args.command = command;
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = rest[i + 1];
  }
  return args;
}

function usage(): never {
  console.error(
    'usage: design_spec.ts save --mission <id> --project-name <name> --file <payload.json> --by <work-item-id> | show|gate --mission <id>'
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mission || !args.command) usage();

  if (args.command === 'show' || args.command === 'gate') {
    const spec = readDesignSpec(args.mission);
    if (!spec) {
      console.log(JSON.stringify({ ok: false, reason: 'no design-spec.json yet' }));
      return;
    }
    const gate = evaluateArchitectureReadyGate(args.mission);
    console.log(
      JSON.stringify({
        ok: true,
        version: spec.version,
        components: spec.components.length,
        architecture_ready: { passed: gate.passed, reasons: gate.reasons },
      })
    );
    return;
  }

  if (args.command !== 'save' || !args.file || !args.projectName || !args.by) usage();
  if (!safeExistsSync(args.file)) {
    console.error(JSON.stringify({ ok: false, error: `payload file not found: ${args.file}` }));
    process.exit(1);
  }
  const extracted = parseSafeJsonInput(
    safeReadFileSnapshot(args.file, 10 * 1024 * 1024).toString('utf8'),
    args.file
  ) as ExtractedDesignSpec;

  const spec = saveDesignSpec({
    missionId: args.mission,
    projectName: args.projectName,
    extracted,
    generatedBy: args.by,
  });
  const gate = evaluateArchitectureReadyGate(args.mission);
  const missionDir = findMissionPath(args.mission);
  console.log(
    JSON.stringify({
      ok: true,
      saved: true,
      path: missionDir ? path.join(missionDir, 'evidence', 'design-spec.json') : null,
      version: spec.version,
      components: spec.components.length,
      architecture_ready: { passed: gate.passed, reasons: gate.reasons },
    })
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  process.exit(1);
});

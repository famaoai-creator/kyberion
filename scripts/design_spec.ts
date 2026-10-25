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
import { missionPathOrNull } from '@agent/core/mission-lookup';
import { defineScript, isDirectScript } from './lib/harness.js';

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

const USAGE =
  'usage: design_spec.ts save --mission <id> --project-name <name> --file <payload.json> --by <work-item-id> | show|gate --mission <id>';

export const runDesignSpec = defineScript({
  name: 'design-spec',
  run(context) {
    const args = parseArgs(context.argv);
    if (!args.mission || !args.command) throw new Error(USAGE);

    if (args.command === 'show' || args.command === 'gate') {
      const spec = readDesignSpec(args.mission);
      if (!spec) {
        context.print({ ok: false, reason: 'no design-spec.json yet' });
        return;
      }
      const gate = evaluateArchitectureReadyGate(args.mission);
      context.print({
        ok: true,
        version: spec.version,
        components: spec.components.length,
        architecture_ready: { passed: gate.passed, reasons: gate.reasons },
      });
      return;
    }

    if (args.command !== 'save' || !args.file || !args.projectName || !args.by) {
      throw new Error(USAGE);
    }
    if (!safeExistsSync(args.file)) {
      throw new Error(`payload file not found: ${args.file}`);
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
    const missionDir = missionPathOrNull(findMissionPath, args.mission);
    context.print({
      ok: true,
      saved: true,
      path: missionDir ? path.join(missionDir, 'evidence', 'design-spec.json') : null,
      version: spec.version,
      components: spec.components.length,
      architecture_ready: { passed: gate.passed, reasons: gate.reasons },
    });
  },
});

if (
  isDirectScript(import.meta.url, 'design_spec.ts') ||
  isDirectScript(import.meta.url, 'design_spec.js')
)
  void runDesignSpec();

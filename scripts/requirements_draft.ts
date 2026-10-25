#!/usr/bin/env node
/**
 * Governed requirements-draft tool for delegated workers.
 *
 * Workers may not write mission evidence directly. Instead they stage a
 * payload under `active/shared/tmp/` and call this script, which validates the
 * JSON through the canonical schema and saves it through the governed
 * `saveRequirementsDraft()` facade (versioned v1, v2, ...; clears stale
 * signoff; then reports the requirements-completeness gate).
 *
 * Usage:
 *   node --import ./scripts/ts-loader.mjs scripts/requirements_draft.ts save \
 *     --mission <MISSION_ID> --project-name <name> --file <payload.json> --by <actor>
 *   node --import ./scripts/ts-loader.mjs scripts/requirements_draft.ts show \
 *     --mission <MISSION_ID>
 */
import * as path from 'node:path';
import {
  saveRequirementsDraft,
  readRequirementsDraft,
  evaluateRequirementsCompletenessGate,
} from '@agent/core/requirements-draft-store';
import { safeReadFileSnapshot, safeExistsSync } from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { findMissionPath } from '@agent/core/path-resolver';

type ExtractedRequirements = Parameters<typeof saveRequirementsDraft>[0]['extracted'];

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
    'usage: requirements_draft.ts save --mission <id> --project-name <name> --file <payload.json> --by <actor> | show --mission <id>'
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mission) usage();

  if (args.command === 'show') {
    const draft = readRequirementsDraft(args.mission);
    if (!draft) {
      console.log(JSON.stringify({ ok: false, reason: 'no requirements-draft.json yet' }));
      return;
    }
    const gate = evaluateRequirementsCompletenessGate(args.mission);
    console.log(
      JSON.stringify({
        ok: true,
        version: draft.version,
        functional_count: draft.functional_requirements.length,
        open_questions: (draft.open_questions || []).length,
        requirements_complete: { passed: gate.passed, reasons: gate.reasons },
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
  ) as ExtractedRequirements;

  const draft = saveRequirementsDraft({
    missionId: args.mission,
    projectName: args.projectName,
    extracted,
    generatedBy: args.by,
  });

  const gate = evaluateRequirementsCompletenessGate(args.mission);
  const missionDir = findMissionPath(args.mission);
  console.log(
    JSON.stringify({
      ok: true,
      saved: true,
      path: missionDir ? path.join(missionDir, 'evidence', 'requirements-draft.json') : null,
      version: draft.version,
      functional_count: draft.functional_requirements.length,
      requirements_complete: { passed: gate.passed, reasons: gate.reasons },
    })
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  process.exit(1);
});

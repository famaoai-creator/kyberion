import { createStandardYargs } from '@agent/core/cli-utils';
import { logger, safeReadFile, pathResolver } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Daemon-Actuator is retired.
 *
 * Historical behavior:
 * - generated launchd plist files
 * - called launchctl directly
 * - provided ad hoc process lifetime management outside runtimeSupervisor
 *
 * Current direction:
 * - long-lived declared services belong to surface-runtime
 * - owned background processes belong to process-actuator
 */

const DEPRECATION_MESSAGE = [
  'daemon-actuator is retired.',
  'Use surface-runtime for declared long-lived services and process-actuator for managed process ownership.',
  'Reference procedure: knowledge/public/procedures/orchestration/replace-daemon-actuator-with-runtime-supervision.md',
  'Reference manifest: knowledge/public/governance/active-surfaces.json',
].join(' ');

interface LegacyDaemonAction {
  action?: string;
  nerve_id?: string;
  script_path?: string;
  adf_path?: string;
  options?: Record<string, unknown>;
}

export async function handleAction(_input: LegacyDaemonAction) {
  throw new Error(DEPRECATION_MESSAGE);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = pathResolver.rootResolve(argv.input as string);
  const input = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string) as LegacyDaemonAction;
  await handleAction(input);
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err: any) => {
    logger.error(err.message);
    process.exit(1);
  });
}

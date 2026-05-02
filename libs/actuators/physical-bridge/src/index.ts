import { createStandardYargs } from '@agent/core/cli-utils';
import { logger, safeReadFile, pathResolver } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Physical-Bridge is retired.
 *
 * Historical behavior:
 * - received KUCA actions
 * - wrote temp JSON files
 * - shelled back into browser/system actuators through cli.js
 *
 * Current direction:
 * - express cross-actuator interaction directly as ADF pipelines
 * - route browser work to browser-actuator
 * - route desktop / voice work to system-actuator
 * - route capture / generation work to media-generation-actuator
 */

const DEPRECATION_MESSAGE = [
  'physical-bridge is retired.',
  'Use direct ADF orchestration over browser-actuator, system-actuator, and media-generation-actuator instead.',
  'Reference pipeline: knowledge/public/governance/pipelines/physical-browser-system-sequence.json',
  'Reference procedure: knowledge/public/procedures/orchestration/replace-physical-bridge-with-adf.md',
].join(' ');

interface LegacyPhysicalBridgeInput {
  actions?: Array<Record<string, unknown>>;
  auto_observe?: boolean;
  session_id?: string;
}

export async function handleAction(_input: LegacyPhysicalBridgeInput) {
  throw new Error(DEPRECATION_MESSAGE);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = pathResolver.rootResolve(argv.input as string);
  const input = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string) as LegacyPhysicalBridgeInput;
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

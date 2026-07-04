import {
  appendGovernedArtifactJsonl,
  createStandardYargs,
  ensureGovernedArtifactDir,
  listGovernedArtifacts,
  logger,
  readGovernedArtifactJson,
  resolveGovernedArtifactPath,
  safeReadFile,
  writeGovernedArtifactJson,
  classifyError,
  type GovernedArtifactRole,
} from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver } from '@agent/core';
import { handleArtifactAction } from './artifact-actuator-helpers.js';
import { runActuatorCli } from '@agent/core';
export { handleArtifactAction as handleAction } from './artifact-actuator-helpers.js';

const main = async () => {
  await runActuatorCli({
    name: 'artifact-actuator',
    handleAction: handleArtifactAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

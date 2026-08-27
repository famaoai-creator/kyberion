/** DH-01: fail if a public operation boundary drops the standard waterfall. */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const boundaries = [
  // The pipeline runner's preflight waterfall lives in the control stage
  // (`ensureDefaultOpPreflight()` is invoked there); `run_pipeline.ts` is only
  // the CLI facade and must not satisfy this gate with a dead import.
  'scripts/pipeline-execution-part-control.ts',
  'libs/actuators/service-actuator/src/service-actuator-helpers.ts',
  'libs/core/agent-dispatch.ts',
  'libs/shared-network/src/mcp-server-engine.ts',
  'libs/actuators/orchestrator-actuator/src/super-nerve/index.ts',
  'libs/core/adf-engine.ts',
  'libs/actuators/terminal-actuator/src/terminal-actuator-helpers.ts',
  'libs/actuators/vision-actuator/src/index.ts',
  'libs/actuators/process-actuator/src/process-actuator-helpers.ts',
  'libs/actuators/secret-actuator/src/secret-actuator-helpers.ts',
  'libs/actuators/deployment-actuator/src/deployment-actuator-helpers.ts',
  'libs/actuators/email-actuator/src/index.ts',
  'libs/actuators/agent-actuator/src/agent-actuator-helpers.ts',
  'libs/actuators/approval-actuator/src/approval-actuator-helpers.ts',
  'libs/actuators/meeting-actuator/src/meeting-actuator-helpers.ts',
  'libs/actuators/voice-actuator/src/index.ts',
  'libs/actuators/android-actuator/src/android-runtime-helpers.ts',
  'libs/actuators/ios-actuator/src/ios-runtime-helpers.ts',
  'libs/actuators/browser-actuator/src/index.ts',
  'libs/actuators/build-actuator/src/build-actuator-helpers.ts',
  'libs/actuators/blockchain-actuator/src/index.ts',
  'libs/actuators/calendar-actuator/src/calendar-actuator-helpers.ts',
  'libs/actuators/presence-actuator/src/presence-actuator-helpers.ts',
  'libs/actuators/working-memory-actuator/src/index.ts',
  'libs/actuators/media-generation-actuator/src/media-generation-action-helpers.ts',
  'libs/actuators/video-composition-actuator/src/video-composition-action-helpers.ts',
  'libs/actuators/ingest-actuator/src/index.ts',
  'libs/actuators/modeling-actuator/src/index.ts',
  'libs/actuators/orchestrator-actuator/src/orchestrator-helpers.ts',
  'libs/actuators/code-actuator/src/code-pipeline-helpers.ts',
  'libs/actuators/wisdom-actuator/src/wisdom-pipeline-helpers.ts',
  'libs/actuators/artifact-actuator/src/artifact-actuator-helpers.ts',
  'libs/actuators/system-actuator/src/system-action-helpers.ts',
];

const missing: string[] = [];
for (const relativePath of boundaries) {
  const absolutePath = pathResolver.rootResolve(relativePath);
  const source = String(safeReadFile(absolutePath, { encoding: 'utf8' }));
  if (!source.includes('ensureDefaultOpPreflight')) {
    missing.push(`${relativePath}: missing ensureDefaultOpPreflight connection`);
  }
}

if (missing.length > 0) {
  console.error('[check:op-preflight-coverage] FAILED');
  for (const finding of missing) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`[check:op-preflight-coverage] OK (${boundaries.length} public boundaries)`);
}

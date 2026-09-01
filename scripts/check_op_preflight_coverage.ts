/** DH-01: fail if a public operation boundary drops the standard waterfall. */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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
  // `reconcile` reads a strategy before entering the helper pipeline, so the
  // public actuator wrapper has its own preflight boundary as well.
  'libs/actuators/orchestrator-actuator/src/index.ts',
  'libs/actuators/code-actuator/src/code-pipeline-helpers.ts',
  'libs/actuators/wisdom-actuator/src/wisdom-pipeline-helpers.ts',
  'libs/actuators/artifact-actuator/src/artifact-actuator-helpers.ts',
  'libs/actuators/media-actuator/src/media-pipeline-helpers.ts',
  'libs/actuators/system-actuator/src/system-action-helpers.ts',
  'libs/actuators/file-actuator/src/file-pipeline-helpers.ts',
  'libs/actuators/network-actuator/src/network-pipeline-helpers.ts',
];

export const OP_PREFLIGHT_BOUNDARIES = boundaries;

const sharedPreflightHelpers = {
  actuatorSdk: 'libs/core/actuator-sdk.ts',
  adfEngine: 'libs/core/adf-engine.ts',
} as const;

export interface OpPreflightCoverageSources {
  boundaries: Record<string, string>;
  shared: Record<keyof typeof sharedPreflightHelpers, string>;
}

/** Replace comments and string/template literals so examples cannot satisfy the gate. */
export function maskNonCode(source: string): string {
  const chars = [...source];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (state === 'line') {
      if (current === '\n' || current === '\r') state = 'code';
      else chars[index] = ' ';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (current === '\n' || current === '\r') {
        if (state !== 'template') state = 'code';
        continue;
      }
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && current === "'") ||
        (state === 'double' && current === '"') ||
        (state === 'template' && current === '`')
      ) {
        state = 'code';
      }
      chars[index] = ' ';
      continue;
    }
    if (current === '/' && next === '/') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'line';
    } else if (current === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'block';
    } else if (current === "'") {
      chars[index] = ' ';
      state = 'single';
    } else if (current === '"') {
      chars[index] = ' ';
      state = 'double';
    } else if (current === '`') {
      chars[index] = ' ';
      state = 'template';
    }
  }
  return chars.join('');
}

function hasCall(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(`, 'u').test(
    maskNonCode(source)
  );
}

export function collectOpPreflightCoverageSources(): OpPreflightCoverageSources {
  const boundarySources = Object.fromEntries(
    boundaries.map((relativePath) => [
      relativePath,
      String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })),
    ])
  );
  const sharedSources = Object.fromEntries(
    Object.entries(sharedPreflightHelpers).map(([key, relativePath]) => [
      key,
      String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })),
    ])
  ) as Record<keyof typeof sharedPreflightHelpers, string>;
  return { boundaries: boundarySources, shared: sharedSources };
}

export function findMissingOpPreflightCoverage(sources: OpPreflightCoverageSources): string[] {
  const hasActuatorSdkPreflight = hasCall(sources.shared.actuatorSdk, 'ensureDefaultOpPreflight');
  const hasAdfEnginePreflight = hasCall(sources.shared.adfEngine, 'ensureDefaultOpPreflight');
  return boundaries.flatMap((relativePath) => {
    const source = sources.boundaries[relativePath] || '';
    const hasDirectPreflight = hasCall(source, 'ensureDefaultOpPreflight');
    const usesSharedPreflight =
      (hasActuatorSdkPreflight &&
        (hasCall(source, 'runActuatorPipeline') || hasCall(source, 'runAdfActuatorPipeline'))) ||
      (hasAdfEnginePreflight && hasCall(source, 'executeAdfSteps'));
    return hasDirectPreflight || usesSharedPreflight
      ? []
      : [`${relativePath}: missing ensureDefaultOpPreflight connection`];
  });
}

export const runCheckOpPreflightCoverage = defineScript({
  name: 'check:op-preflight-coverage',
  flags: [],
  run(context) {
    const missing = findMissingOpPreflightCoverage(collectOpPreflightCoverageSources());
    if (missing.length > 0) {
      throw new ScriptExitError(
        1,
        ['FAILED', ...missing.map((finding) => `- ${finding}`)].join('\n')
      );
    }
    context.print(
      `[check:op-preflight-coverage] OK (${OP_PREFLIGHT_BOUNDARIES.length} public boundaries)`
    );
    return { missing };
  },
});

if (
  isDirectScript(import.meta.url, 'check_op_preflight_coverage.ts') ||
  isDirectScript(import.meta.url, 'check_op_preflight_coverage.js')
)
  void runCheckOpPreflightCoverage();

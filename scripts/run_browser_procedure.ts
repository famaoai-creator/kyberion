/**
 * Run a browser procedure, approved recording, or hand-authored ADF through
 * the Playwright execution substrate.
 *
 * Pattern B entry point for `execution_substrate: 'playwright'` — mirrors
 * `scripts/run_service_procedure.ts`. Dynamically loads browser-actuator
 * `handleAction` (no `libs/core` → actuator import) and injects it into
 * `dispatchProcedure`, so the approval gate and origin allowlist stay
 * identical to the Chrome extension path.
 *
 * Usage:
 *   pnpm kyberion browser run --procedure-id <id> [--headed]
 *   pnpm kyberion browser run --recording <allowlisted-recording.json> [--headed]
 *   pnpm kyberion browser run --adf libs/actuators/browser-actuator/examples/explore-and-export.json
 */

import { dispatchProcedure } from '@agent/core/procedure-dispatcher';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { loadBrowserExtensionRecordingAtPath } from '@agent/core/browser-extension-bridge';
import { compileBrowserRecording } from '@agent/core/browser-recording-compiler';
import { withExecutionContext } from '@agent/core/authority';
import { loadProcedures, resolveAllowlistedRecordingRef } from '@agent/core/procedure-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { createStandardYargs } from '@agent/core/cli-utils';
import type { BrowserExtensionRecording } from '@agent/core/browser-extension-bridge';
import type { ProcedureEntry } from '@agent/core/procedure-types';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';
import {
  assertSupportedNodeEngine,
  createExecuteBrowserPipeline,
  loadBrowserActuator,
  type BrowserActuatorHandle,
  type ExecuteBrowserPipeline,
} from './browser_playwright_executor.js';

const USAGE = [
  '[run-browser-procedure] Usage:',
  '  pnpm kyberion browser run --procedure-id <id> [--headed]',
  '  pnpm kyberion browser run --recording <allowlisted-recording.json> [--headed]',
  '  pnpm kyberion browser run --adf <browser-actuator-example.json> [--headed]',
  '',
  'Governed recording/procedure runs use the same approval gate and origin',
  'allowlist as the Chrome extension path.',
  'Hand-authored --adf examples call browser-actuator directly (not the',
  'recording approval gate). Compiled recording drafts',
  '(_source.kind=browser-recording.v1) must use --recording or --procedure-id.',
].join('\n');

export interface RunBrowserProcedureDeps {
  loadActuator?: () => Promise<BrowserActuatorHandle>;
  dispatch?: typeof dispatchProcedure;
  loadCatalog?: typeof loadProcedures;
  loadRecordingAtPath?: typeof loadBrowserExtensionRecordingAtPath;
  resolveRecordingRef?: typeof resolveAllowlistedRecordingRef;
  readAdf?: (filePath: string, label: string) => Record<string, unknown>;
  nodeVersion?: string;
  missionId?: string;
}

function requestedOperations(recording: BrowserExtensionRecording): string[] {
  return Array.from(
    new Set(
      recording.actions.map((action) => action.op).filter((op) => op !== 'sensitive_input_omitted')
    )
  );
}

function asPlaywrightProcedure(entry: ProcedureEntry): ProcedureEntry {
  return { ...entry, execution_substrate: 'playwright' };
}

function procedureFromRecording(
  recording: BrowserExtensionRecording,
  recordingRef: string
): ProcedureEntry {
  const compiled = compileBrowserRecording(recording, {
    intentPhrases: [recording.tab.title || recording.recording_id || 'playwright-run'],
    recordingRef,
  });
  return asPlaywrightProcedure(compiled.procedureEntry);
}

function isCompiledRecordingDraft(value: Record<string, unknown>): boolean {
  const source = value._source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  return (source as { kind?: unknown }).kind === 'browser-recording.v1';
}

async function bindExecutor(
  deps: RunBrowserProcedureDeps,
  options: {
    sessionId?: string;
    headless: boolean;
    connectOverCdp: boolean;
    cdpUrl?: string;
    cdpPort?: number;
    context: Record<string, unknown>;
  }
): Promise<ExecuteBrowserPipeline> {
  const actuator = await (deps.loadActuator ?? loadBrowserActuator)();
  return createExecuteBrowserPipeline(actuator.handleAction, options);
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = (value) => {
    console.log(value);
  },
  deps: RunBrowserProcedureDeps = {}
): Promise<void> {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const argv = await createStandardYargs(['node', 'run_browser_procedure', ...normalizedArgs])
    .option('procedure-id', {
      type: 'string',
      description: 'Catalog procedure id (browser substrate)',
    })
    .option('recording', {
      type: 'string',
      description: 'Allowlisted approved browser-recording.v1 path',
    })
    .option('adf', {
      type: 'string',
      description: 'Hand-authored browser-actuator ADF / example JSON',
    })
    .option('headed', {
      type: 'boolean',
      default: false,
      description: 'Launch a visible Chromium window (standalone Playwright)',
    })
    .option('cdp-url', {
      type: 'string',
      description: 'Attach to an existing Chrome DevTools endpoint',
    })
    .option('cdp-port', {
      type: 'number',
      description: 'Attach to an existing Chrome DevTools port',
    })
    .option('tab-id', {
      type: 'string',
      description: 'Optional session/tab id (required only for CDP attach)',
    })
    .option('mission-id', { type: 'string', description: 'Mission id for the dispatch' })
    .option('json', { type: 'boolean', default: false })
    .parse();

  if (argv.help === true) {
    print(USAGE);
    return;
  }

  const procedureId = argv['procedure-id'] ? String(argv['procedure-id']) : '';
  const recordingRef = argv.recording ? String(argv.recording) : '';
  const adfPath = argv.adf ? String(argv.adf) : argv.input ? String(argv.input) : '';
  const selected = [
    procedureId && 'procedure-id',
    recordingRef && 'recording',
    adfPath && 'adf',
  ].filter(Boolean);
  if (selected.length === 0) {
    print(USAGE);
    throw new ScriptExitError(
      1,
      'one of --procedure-id, --recording, or --adf/--input is required'
    );
  }
  if (selected.length > 1) {
    throw new ScriptExitError(1, 'use only one of --procedure-id, --recording, or --adf/--input');
  }

  assertSupportedNodeEngine(deps.nodeVersion ?? process.version);

  const headed = Boolean(argv.headed);
  const cdpUrl = argv['cdp-url'] ? String(argv['cdp-url']) : undefined;
  const cdpPort = typeof argv['cdp-port'] === 'number' ? Number(argv['cdp-port']) : undefined;
  const tabId = argv['tab-id'] ? String(argv['tab-id']) : undefined;
  const connectOverCdp = Boolean(cdpUrl || cdpPort || tabId);
  const missionId =
    (argv['mission-id'] ? String(argv['mission-id']) : '') ||
    deps.missionId ||
    getRegisteredEnvText('MISSION_ID') ||
    `MSN-BROWSER-${procedureId || 'playwright'}`;

  if (adfPath) {
    const abs = assertSafeRepositoryPath(pathResolver.rootResolve(adfPath), {
      allowMissingLeaf: true,
    });
    const readAdf = deps.readAdf ?? readSafeJsonFile<Record<string, unknown>>;
    const adf = readAdf(abs, 'browser ADF');
    if (isCompiledRecordingDraft(adf)) {
      throw new ScriptExitError(
        1,
        'compiled recording drafts must run via --recording or --procedure-id so the approval gate and origin allowlist still apply'
      );
    }
    if (adf.action !== 'pipeline' || !Array.isArray(adf.steps)) {
      throw new ScriptExitError(
        1,
        'ADF JSON must be a browser-actuator pipeline contract ({ action: "pipeline", steps })'
      );
    }
    const actuator = await (deps.loadActuator ?? loadBrowserActuator)();
    const result = await actuator.handleAction({
      ...adf,
      options: {
        ...((adf.options as Record<string, unknown> | undefined) || {}),
        headless: headed ? false : true,
        connect_over_cdp: connectOverCdp,
        ...(cdpUrl ? { cdp_url: cdpUrl } : {}),
        ...(cdpPort ? { cdp_port: cdpPort } : {}),
      },
      context: {
        ...((adf.context as Record<string, unknown> | undefined) || {}),
        source: 'run-browser-procedure',
        mission_id: missionId,
      },
    });
    const payload = {
      mode: 'adf',
      mission_id: missionId,
      result,
    };
    print(
      argv.json
        ? JSON.stringify(payload, null, 2)
        : `[run-browser-procedure] adf ${result.status ?? 'unknown'}`
    );
    if (argv.json !== true && result && typeof result === 'object') {
      print(JSON.stringify(result, null, 2));
    }
    if (!result || (result.status !== 'succeeded' && result.status !== 'success')) {
      throw new ScriptExitError(
        1,
        `adf execution failed: ${(result?.errors || []).join('; ') || result?.status}`
      );
    }
    return;
  }

  const loadCatalog = deps.loadCatalog ?? loadProcedures;
  const resolveRecording = deps.resolveRecordingRef ?? resolveAllowlistedRecordingRef;
  const loadRecording = deps.loadRecordingAtPath ?? loadBrowserExtensionRecordingAtPath;
  const dispatch = deps.dispatch ?? dispatchProcedure;

  let entry: ProcedureEntry | undefined;
  let recording: BrowserExtensionRecording;
  let recordingPath: string;

  if (procedureId) {
    entry = loadCatalog().find((candidate) => candidate.procedure_id === procedureId);
    if (!entry) throw new ScriptExitError(1, `procedure "${procedureId}" not found in catalog`);
    if (entry.substrate !== 'browser') {
      throw new ScriptExitError(
        1,
        `procedure "${procedureId}" is not a browser procedure (substrate=${entry.substrate})`
      );
    }
    const resolved = resolveRecording(entry.adapter.recording_ref);
    if (!resolved) {
      throw new ScriptExitError(1, `procedure "${procedureId}" has no allowlisted recording_ref`);
    }
    recordingPath = resolved;
    recording = loadRecording(recordingPath);
    entry = asPlaywrightProcedure(entry);
  } else {
    const resolved =
      resolveRecording(recordingRef) ??
      resolveRecording(pathResolver.toRepoRelative(pathResolver.rootResolve(recordingRef)));
    if (!resolved) {
      throw new ScriptExitError(
        1,
        `recording "${recordingRef}" is not inside an allowlisted browser recordings store`
      );
    }
    recordingPath = resolved;
    recording = loadRecording(recordingPath);
    entry = procedureFromRecording(recording, pathResolver.toRepoRelative(recordingPath));
  }

  const executeBrowserPipeline = await bindExecutor(deps, {
    sessionId: tabId || recording.recording_id,
    headless: headed ? false : true,
    connectOverCdp,
    cdpUrl,
    cdpPort,
    context: {
      procedure_id: entry.procedure_id,
      mission_id: missionId,
      source: 'run-browser-procedure',
    },
  });

  const result = await withExecutionContext('surface_runtime', () =>
    dispatch({
      procedure: entry!,
      recording,
      session: {
        kind: 'browser-extension-session.v1',
        mission_id: missionId,
        pipeline_id: entry!.pipeline_ref,
        tab_id: tabId || '',
        origin: recording.tab.origin,
        mode: 'execute',
        recording_id: recording.recording_id,
        requested_operations: requestedOperations(recording) as never,
      },
      agentId: 'run-browser-procedure',
      missionId,
      pipelineId: entry.pipeline_ref,
      channel: 'cli',
      executeBrowserPipeline,
    })
  );

  const payload = {
    procedure_id: entry.procedure_id,
    execution_substrate: entry.execution_substrate,
    mission_id: missionId,
    result,
  };
  if (argv.json) {
    print(JSON.stringify(payload, null, 2));
  } else {
    print(`[run-browser-procedure] ${result.status} "${entry.procedure_id}"`);
    if (result.approvalRequestId) {
      print(
        `[run-browser-procedure] approval required (request ${result.approvalRequestId}). Approve in Kyberion and re-run.`
      );
    }
    if (result.errors.length > 0) print(result.errors.join('; '));
    if (result.browserResults) print(JSON.stringify(result.browserResults, null, 2));
  }

  if (result.status === 'approval_required') {
    throw new ScriptExitError(2);
  }
  if (result.status !== 'executed') {
    throw new ScriptExitError(1, `${result.status}: ${result.errors.join('; ')}`);
  }
}

export const runBrowserProcedure = defineScript({
  name: 'run-browser-procedure',
  flags: ['json', 'quiet'],
  async run(context) {
    await main(context.positional, context.print);
  },
});

if (
  isDirectScript(import.meta.url, 'run_browser_procedure.ts') ||
  isDirectScript(import.meta.url, 'run_browser_procedure.js')
) {
  void runBrowserProcedure();
}

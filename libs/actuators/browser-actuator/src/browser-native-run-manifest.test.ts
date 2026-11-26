/**
 * A native browser pipeline's runtime marks each step with the same entry id
 * and authored-params hash the Run Manifest compiler assigned
 * (pipeline-run-manifest-model.md §3.5) — through the browser actuator's own
 * engine, its real if / while control handlers and on_error fallbacks.
 */
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupCreatedLivePaths } from '../../../../tests/helpers/live-path-cleanup.js';
import { runAdfActuatorPipeline } from '@agent/core/actuator/actuator-sdk';
import type { AdfStep } from '@agent/core/pipeline/adf-engine';
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-presentation';
import {
  currentRunManifestBinding,
  currentRunManifestStep,
} from '@agent/core/governance/external-operation-runtime';
import {
  BROWSER_NATIVE_FORMAT,
  compileRunManifest,
  type RunManifest,
  type RunManifestSessionInput,
  type RunScope,
} from '@agent/core/pipeline/run-manifest';
import { opControl } from './browser-control-helpers.js';
import {
  claimNativeBrowserRun,
  confineNativeRunContinueFile,
  confineNativeRunReadPath,
  confineNativeRunWritePath,
  nativeBrowserStepTag,
  runNativeBrowserPipelineFile,
  tagNativeBrowserSteps,
} from './browser-native-run-manifest.js';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { resolveRole, withExecutionContextAsync } from '@agent/core/authority';
import { browserRuntimeHelpers, externalBrowserAttachAllowed } from './browser-runtime-helpers.js';

// Writes confined to literal browser partitions cannot be sandboxed; remove what this file created.
afterAll(cleanupCreatedLivePaths(['active/shared/runtime/browser/profiles/confidential/acme']));

const INPUT = 'knowledge/confidential/acme/browser-workflows/scenarios/native-parity.json';
const SCOPE: RunScope = {
  input_path: INPUT,
  tier: 'confidential',
  tenant_slug: 'acme',
  source: 'location',
};

/** Every nested body shape the native runtime runs. */
const FILE = {
  action: 'pipeline',
  session_id: 'parity',
  options: {
    headless: true,
    connect_over_cdp: true,
    user_data_dir: 'active/shared/runtime/browser/profiles/confidential/acme/parity',
  },
  context: { flag: true },
  steps: [
    { type: 'capture', op: 'goto', params: { url: 'https://app.example.test/login' } },
    {
      type: 'control',
      op: 'if',
      params: {
        condition: { from: 'flag', operator: 'eq', value: true },
        then: [{ type: 'capture', op: 'evaluate', params: { script: 'document.title' } }],
        else: [{ type: 'apply', op: 'click', params: { selector: '#never' } }],
      },
    },
    {
      type: 'control',
      op: 'while',
      params: {
        condition: { from: 'flag', operator: 'eq', value: true },
        max_iterations: 2,
        pipeline: [{ type: 'apply', op: 'fill', params: { selector: '#q', text: '{{flag}}' } }],
      },
    },
    {
      type: 'apply',
      op: 'click',
      params: { selector: '#flaky' },
      on_error: {
        strategy: 'fallback',
        fallback: [{ type: 'capture', op: 'goto', params: { url: 'https://app.example.test/' } }],
      },
    },
  ],
};

const manifest: RunManifest = compileRunManifest(FILE.steps, {
  inputPath: INPUT,
  contentSha256: 'p'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
  pipelineOptions: FILE.options,
  format: BROWSER_NATIVE_FORMAT,
});

interface Dispatch {
  op: string;
  entryId?: string;
  authoredHash?: string;
}

/** The browser actuator's step loop with recording leaf handlers. */
async function runFileSteps(steps: unknown[]) {
  const dispatched: Dispatch[] = [];
  let applied: Record<string, unknown> | undefined;
  let nestedSeen: boolean | undefined;
  const record = async (op: string, ctx: Record<string, unknown>) => {
    const step = currentRunManifestStep();
    dispatched.push({
      op,
      ...(step
        ? {
            entryId: step.entryId,
            authoredHash: computeApprovalPayloadHash(step.authoredParams ?? {}),
          }
        : {}),
    });
    if (op === 'click' && dispatched.at(-1)?.entryId === '3') throw new Error('element not found');
    return ctx;
  };
  const native = claimNativeBrowserRun();
  applied = native.claim?.options;
  // A second pipeline execution in the same run is not the file's own.
  nestedSeen = claimNativeBrowserRun().nested;
  const result = await runAdfActuatorPipeline({
    actuatorId: 'browser',
    steps: (native.claim ? native.claim.tagSteps(steps) : steps) as AdfStep[],
    context: { flag: true },
    options: native.claim ? { withStep: native.claim.withStep } : {},
    handlers: {
      capture: (op, _params, ctx) => record(op, ctx),
      transform: async (_op, _params, ctx) => ctx,
      apply: (op, _params, ctx) => record(op, ctx),
      control: (op, params, ctx, runSteps, resolve) =>
        opControl(op, params, {} as never, ctx, runSteps, resolve),
    },
  });
  return { result, dispatched, applied, nestedSeen };
}

function openSession(input: RunManifestSessionInput) {
  expect(input.format).toBe('browser_native');
  return {
    binding: { manifest, charterId: 'charter-native', principal: 'attended' as const, runId: 'r' },
    manifest,
    admitting: true,
    message: 'run manifest: bound (test)',
    level: 'debug' as const,
  };
}

describe('native browser pipeline: runtime entry ids', () => {
  it('marks every step with the compiler entry id and authored params hash', async () => {
    const run = await runNativeBrowserPipelineFile(
      { inputPath: INPUT, sourceText: JSON.stringify(FILE), pipeline: FILE },
      () => runFileSteps(FILE.steps),
      { hasHuman: false, deps: { runId: 'r', deriveScope: () => SCOPE, openSession } }
    );
    expect(run.result.status, JSON.stringify(run.result.results)).toBe('succeeded');
    const leaves = run.dispatched;
    expect(leaves.map((entry) => entry.entryId)).toEqual([
      '0',
      '1.then.0',
      '2.pipeline.0',
      '2.pipeline.0',
      '3',
      '3.on_error.fallback.0',
    ]);
    const hashes = new Map(
      manifest.requirements.effects.map((entry) => [entry.entry_id, entry.params_template_hash])
    );
    for (const entry of leaves) {
      expect(hashes.has(entry.entryId!), entry.entryId).toBe(true);
      expect(entry.authoredHash).toBe(hashes.get(entry.entryId!));
    }
    // The bound run applies the file options through the shared classifier.
    expect(run.applied).toEqual({
      headless: true,
      user_data_dir: 'active/shared/runtime/browser/profiles/confidential/acme/parity',
    });
    expect(run.nestedSeen).toBe(true);
  });

  it('runs exactly as before when the file has no approved manifest', async () => {
    const run = await runNativeBrowserPipelineFile(
      { inputPath: INPUT, sourceText: JSON.stringify(FILE), pipeline: FILE },
      async () => ({ binding: currentRunManifestBinding(), ...(await runFileSteps(FILE.steps)) }),
      {
        hasHuman: true,
        deps: {
          deriveScope: () => SCOPE,
          openSession: () => ({
            manifest,
            message: 'run manifest: not bound — test',
            level: 'debug',
          }),
        },
      }
    );
    expect(run.binding).toBeUndefined();
    expect(run.applied).toBeUndefined();
    expect(run.nestedSeen).toBe(false);
    expect(run.dispatched.every((entry) => entry.entryId === undefined)).toBe(true);
  });

  it('runs unbound when the scope cannot be derived', async () => {
    const run = await runNativeBrowserPipelineFile(
      { inputPath: INPUT, sourceText: '{}', pipeline: FILE },
      async () => currentRunManifestBinding(),
      {
        hasHuman: true,
        deps: {
          deriveScope: () => {
            throw new Error('[RUN_SCOPE_MISMATCH] test');
          },
          openSession: () => {
            throw new Error('never opened');
          },
        },
      }
    );
    expect(run).toBeUndefined();
  });

  it('tags copies only: the authored steps and JSON never carry an entry', () => {
    const [tagged] = tagNativeBrowserSteps([FILE.steps[1]]) as Array<{
      params: { then: object[] };
    }>;
    expect(JSON.parse(JSON.stringify(tagged))).toEqual(FILE.steps[1]);
    expect(Object.getOwnPropertySymbols(tagged)).toHaveLength(1);
    expect(Object.getOwnPropertySymbols(FILE.steps[1])).toHaveLength(0);
    expect(Object.getOwnPropertySymbols(tagged.params.then[0])).toHaveLength(1);
  });

  const file = { inputPath: INPUT, sourceText: JSON.stringify(FILE), pipeline: FILE };

  it('does not switch anything when the binding would admit nothing', async () => {
    const observed = await runNativeBrowserPipelineFile(
      file,
      async (bound) => ({
        bound,
        binding: currentRunManifestBinding(),
        claim: claimNativeBrowserRun(),
      }),
      {
        hasHuman: false,
        deps: {
          deriveScope: () => SCOPE,
          // principal not in the approved modes: a binding, but admitting nothing
          openSession: (input) => ({ ...openSession(input), admitting: false, level: 'warn' }),
        },
      }
    );
    expect(observed).toEqual({ bound: false, binding: undefined, claim: { nested: false } });
  });

  it('never binds a file the approval reads as an ADF', async () => {
    const adfShaped = {
      ...FILE,
      steps: [
        { type: 'capture', op: 'browser:goto', params: { url: 'https://app.example.test/' } },
      ],
    };
    const observed = await runNativeBrowserPipelineFile(
      { ...file, pipeline: adfShaped },
      async (bound) => bound,
      {
        hasHuman: true,
        deps: {
          deriveScope: () => SCOPE,
          openSession: () => {
            throw new Error('never opened for a non-native file');
          },
        },
      }
    );
    expect(observed).toBe(false);
  });

  it('numbers malformed steps by raw index exactly as the compiler does', () => {
    const steps = [
      FILE.steps[0],
      { note: 'not a step' },
      'nor this',
      { type: 'apply', op: 'click', params: { selector: '#go' } },
    ];
    const compiled = compileRunManifest(steps, {
      inputPath: INPUT,
      contentSha256: 'q'.repeat(64),
      scope: { tier: 'confidential', tenantSlug: 'acme' },
      format: BROWSER_NATIVE_FORMAT,
    });
    const tagged = tagNativeBrowserSteps(steps);
    expect(nativeBrowserStepTag(tagged[3])?.entryId).toBe('3');
    expect(compiled.requirements.effects.map((entry) => entry.entry_id)).toEqual(['0', '3']);
  });

  it('confines step-authored files of a bound run to its partition', async () => {
    const abs = (rel: string) => pathResolver.rootResolve(rel);
    // Outside a bound run: unchanged.
    expect(confineNativeRunWritePath(abs('knowledge/public/x.png'))).toBe(
      abs('knowledge/public/x.png')
    );
    await runNativeBrowserPipelineFile(
      file,
      async () => {
        for (const ok of [
          'evidence/browser/shot.png',
          'active/shared/tmp/confidential/acme/browser/shot.png',
          'active/shared/artifacts/confidential/acme/browser/run/shot.png',
        ])
          expect(confineNativeRunWritePath(abs(ok))).toBe(abs(ok));
        for (const denied of [
          'active/shared/tmp/shot.png',
          'active/shared/tmp/confidential/other/browser/shot.png',
          'knowledge/confidential/acme/shot.png',
        ])
          expect(() => confineNativeRunWritePath(abs(denied))).toThrow(
            /BROWSER_RUN_PATH_CONFINED/u
          );
        expect(() =>
          confineNativeRunContinueFile(abs('knowledge/confidential/acme/go.continue'))
        ).toThrow(/BROWSER_RUN_PATH_CONFINED/u);
        const continueFile = pathResolver.shared('runtime/browser/s.continue');
        expect(confineNativeRunContinueFile(continueFile)).toBe(continueFile);
      },
      { hasHuman: false, deps: { runId: 'r', deriveScope: () => SCOPE, openSession } }
    );
  });

  it('confines a session handoff read and refuses symbolic links on a step path', async () => {
    const abs = (rel: string) => pathResolver.rootResolve(rel);
    const dir = `active/shared/tmp/confidential/acme/browser/link-test-${process.pid}`;
    const outsideDir = `active/shared/tmp/link-target-${process.pid}`;
    safeMkdir(abs(dir), { recursive: true });
    safeMkdir(abs(outsideDir), { recursive: true });
    safeWriteFile(abs(`${dir}/handoff.json`), '{}');
    safeWriteFile(abs(`${outsideDir}/handoff.json`), '{}');
    // A link inside the partition whose target is outside it.
    safeSymlinkSync(abs(outsideDir), abs(`${dir}/escape`), 'dir');
    try {
      // Outside a bound run: unchanged.
      expect(confineNativeRunReadPath(abs(`${outsideDir}/handoff.json`))).toBe(
        abs(`${outsideDir}/handoff.json`)
      );
      await runNativeBrowserPipelineFile(
        file,
        async () => {
          expect(confineNativeRunReadPath(abs(`${dir}/handoff.json`))).toBe(
            abs(`${dir}/handoff.json`)
          );
          expect(() => confineNativeRunReadPath(abs(`${outsideDir}/handoff.json`))).toThrow(
            /BROWSER_RUN_PATH_CONFINED/u
          );
          expect(() => confineNativeRunWritePath(abs(`${dir}/escape/shot.png`))).toThrow(
            /RESOURCE_PATH_SYMLINK/u
          );
          expect(() => confineNativeRunReadPath(abs(`${dir}/escape/handoff.json`))).toThrow(
            /RESOURCE_PATH_SYMLINK/u
          );
        },
        { hasHuman: false, deps: { runId: 'r', deriveScope: () => SCOPE, openSession } }
      );
    } finally {
      safeRmSync(abs(dir), { recursive: true, force: true });
      safeRmSync(abs(outsideDir), { recursive: true, force: true });
    }
  });

  it("under surface_runtime, a bound run reads a handoff only from its own tenant's partitions", async () => {
    const abs = (rel: string) => pathResolver.rootResolve(rel);
    const tag = `handoff-${process.pid}`;
    const own = `active/shared/tmp/confidential/acme/browser/${tag}.json`;
    const otherScratch = `active/shared/tmp/confidential/zz-other/browser/${tag}.json`;
    const otherProfile = `active/shared/runtime/browser/profiles/confidential/zz-other/${tag}/handoff.json`;
    const ownProfile = `active/shared/runtime/browser/profiles/confidential/acme/${tag}/handoff.json`;
    const unpartitioned = `active/shared/runtime/browser/${tag}.json`;
    const all = [own, otherScratch, otherProfile, ownProfile, unpartitioned];
    for (const rel of all) {
      safeMkdir(path.dirname(abs(rel)), { recursive: true });
      safeWriteFile(abs(rel), JSON.stringify({ cookies: [], marker: rel }));
    }
    const load = (rel: string) =>
      browserRuntimeHelpers.resolveSessionHandoff({ path: rel }, {}, (value: unknown) => value);
    try {
      // A broad caller (the operator identity running the entry) can read every one of them.
      const asCaller = <T>(fn: () => Promise<T>) =>
        withExecutionContextAsync('mission_controller', fn, 'ecosystem_architect');
      await asCaller(async () => {
        for (const rel of all) expect((await load(rel)).marker).toBe(rel);
      });
      const seen: string[] = [];
      await runNativeBrowserPipelineFile(
        file,
        () =>
          withExecutionContextAsync(
            'surface_runtime',
            async () => {
              seen.push(resolveRole());
              // Its own partitions stay readable to the bound run.
              expect((await load(own)).marker).toBe(own);
              expect((await load(ownProfile)).marker).toBe(ownProfile);
              // Another tenant's scratch or profile, or the shared runtime
              // directory, is refused before the file is looked at.
              for (const rel of [otherScratch, otherProfile, unpartitioned])
                await expect(load(rel), rel).rejects.toThrow(/BROWSER_RUN_PATH_CONFINED/u);
              // And the run's identity itself cannot read the other tenant's file.
              expect(() => safeReadFile(abs(otherScratch), { encoding: 'utf8' })).toThrow(
                /ROLE_VIOLATION|POLICY_VIOLATION|TENANT/u
              );
            },
            undefined,
            'acme'
          ),
        { hasHuman: false, deps: { runId: 'r', deriveScope: () => SCOPE, openSession } }
      );
      expect(seen).toEqual(['surface_runtime']);
    } finally {
      for (const rel of [
        own,
        unpartitioned,
        'active/shared/tmp/confidential/zz-other',
        'active/shared/runtime/browser/profiles/confidential/zz-other',
        path.posix.dirname(ownProfile),
      ])
        safeRmSync(abs(rel), { recursive: true, force: true });
    }
  });

  it('never attaches to an external browser under a binding', async () => {
    expect(externalBrowserAttachAllowed()).toBe(true);
    await runNativeBrowserPipelineFile(
      file,
      async () => {
        expect(externalBrowserAttachAllowed()).toBe(false);
      },
      { hasHuman: false, deps: { runId: 'r', deriveScope: () => SCOPE, openSession } }
    );
  });
});

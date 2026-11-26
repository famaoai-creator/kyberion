/**
 * The Run Manifest compiler is at least as strict as the browser runtime's
 * external-operation gate: for every op the native engine can dispatch (each
 * per-type handler map, and the control ops), a step the runtime sends
 * through `runExternalOperation` is an effect in the compiled manifest
 * (pipeline-run-manifest-model.md §3.5). The gate is observed, not assumed:
 * `runExternalOperation` is replaced by a recorder that stops the handler.
 */
import { describe, expect, it, vi } from 'vitest';

const gated: string[] = [];
vi.mock('@agent/core/governance/external-operation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/external-operation')>()),
  runExternalOperation: vi.fn(async (input: { operationId: string }) => {
    gated.push(input.operationId);
    throw new Error('GATED');
  }),
}));

const { BROWSER_NATIVE_FORMAT, compileRunManifest } =
  await import('@agent/core/pipeline/run-manifest');
const { BROWSER_APPLY_OP_HANDLERS, BROWSER_CAPTURE_OP_HANDLERS, BROWSER_TRANSFORM_OP_HANDLERS } =
  await import('./browser-pipeline-op-handlers.js');
const { BROWSER_ACTUATOR_CONTROL_OPS } = await import('./op-catalog.js');
const { opControl } = await import('./browser-control-helpers.js');

const URL = 'https://app.example.test/';

function stubRuntime() {
  const page = { url: () => URL, isClosed: () => false };
  return {
    page,
    runtime: {
      activeTabId: 'tab-1',
      tabs: new Map([['tab-1', page]]),
      context: {},
      consoleEvents: [],
      networkEvents: [],
    },
  };
}

/** Whether the runtime routes the op through the external-operation gate. */
async function runtimeGates(kind: string, op: string): Promise<boolean> {
  gated.length = 0;
  const { page, runtime } = stubRuntime();
  const call = async () => {
    if (kind === 'control')
      return opControl(
        op,
        {},
        runtime as never,
        {},
        async () => ({}) as never,
        (v) => v
      );
    const handlers = (
      {
        capture: BROWSER_CAPTURE_OP_HANDLERS,
        apply: BROWSER_APPLY_OP_HANDLERS,
        transform: BROWSER_TRANSFORM_OP_HANDLERS,
      } as Record<string, Record<string, (input: never) => Promise<unknown>>>
    )[kind];
    return handlers[op]({
      op,
      params: {},
      runtime,
      page,
      ctx: {},
      resolve: (value: unknown) => value,
      buildRetryOptions: () => ({ maxRetries: 0 }),
      fillWithFallback: async () => undefined,
      resolveBrowserRepositoryPath: (ref: unknown) => String(ref),
    } as never);
  };
  // An ungated handler running against the stub may fail or wait; only the
  // recorder decides. The gate is reached without any timer
  // (runBrowserMutation calls runExternalOperation before its first await),
  // so a handler still pending after a few event-loop turns never reached it.
  const settled = call().catch(() => undefined);
  for (let turn = 0; turn < 20 && gated.length === 0; turn += 1)
    await Promise.race([settled, new Promise((resolve) => setImmediate(resolve))]);
  return gated.length > 0;
}

function compiledEffect(kind: string, op: string): boolean {
  const manifest = compileRunManifest([{ type: kind, op, params: {} }], {
    inputPath: 'knowledge/confidential/acme/browser-workflows/scenarios/table.json',
    contentSha256: 't'.repeat(64),
    scope: { tier: 'confidential', tenantSlug: 'acme' },
    format: BROWSER_NATIVE_FORMAT,
  });
  return manifest.requirements.effects.length > 0;
}

describe('native admission table: compiler ⊇ runtime gate', () => {
  const table: Array<[string, string]> = [
    ...Object.keys(BROWSER_CAPTURE_OP_HANDLERS).map((op) => ['capture', op] as [string, string]),
    ...Object.keys(BROWSER_APPLY_OP_HANDLERS).map((op) => ['apply', op] as [string, string]),
    ...Object.keys(BROWSER_TRANSFORM_OP_HANDLERS).map(
      (op) => ['transform', op] as [string, string]
    ),
    ...BROWSER_ACTUATOR_CONTROL_OPS.map((op) => ['control', op] as [string, string]),
  ];

  it('compiles every runtime-gated op as a manifest effect', async () => {
    const observed: string[] = [];
    const looser: string[] = [];
    for (const [kind, op] of table) {
      if (!(await runtimeGates(kind, op))) continue;
      observed.push(`${kind}:${op}`);
      if (!compiledEffect(kind, op)) looser.push(`${kind}:${op}`);
    }
    // The harness really observes the gate (these are known to be gated).
    expect(observed).toEqual(
      expect.arrayContaining(['capture:goto', 'capture:evaluate', 'apply:fill', 'apply:click'])
    );
    expect(looser).toEqual([]);
  }, 120000);

  it('never pre-approves a session handoff import', () => {
    const manifest = compileRunManifest(
      [
        { type: 'capture', op: 'goto', params: { url: URL } },
        { type: 'apply', op: 'import_session_handoff', params: { path: 'x.json' } },
      ],
      {
        inputPath: 'knowledge/confidential/acme/browser-workflows/scenarios/table.json',
        contentSha256: 't'.repeat(64),
        scope: { tier: 'confidential', tenantSlug: 'acme' },
        format: BROWSER_NATIVE_FORMAT,
      }
    );
    expect(manifest.requirements.effects[1]).toMatchObject({
      operation_id: 'browser:import_session_handoff',
      bindable: false,
      unbindable_reason: 'not_manifest_bindable',
    });
  });
});

/**
 * Mechanical scan of every handler the native engine dispatches: a handler
 * whose source touches a step-supplied file (a path-like param or a file
 * sink) must be a declared write op (confined, `write_path_unconfined` when
 * outside), a declared read op (confined under a binding), or listed below
 * with the reason it is not a file. The scan also proves it saw every key of
 * every handler map, so a new op cannot slip past it.
 */
describe('native file-touching handlers are all declared', () => {
  const FILE_TOUCH =
    /params\.\w*(?:path|file|dir)\w*\b|safeWriteFile|saveFailureBundle|resolveBrowserRepositoryPath|resolveSessionHandoff|setInputFiles|\.saveAs\(/u;
  /** Ops whose path-like param is not a file, with the reason. */
  const NOT_A_FILE: Record<string, string> = {
    json_query: 'params.path is a JSON path into data',
    // Control ops with their own confinement or manifest treatment:
    pause_for_operator:
      'continue_file is confined to runtime/browser by confineNativeRunContinueFile',
    ref: 'reads a pipeline fragment; the manifest marks it incomplete and its steps carry no entry',
  };

  function handlerBodies(source: string, mapStart: RegExp, indent: string): Map<string, string> {
    const start = source.search(mapStart);
    expect(start, String(mapStart)).toBeGreaterThanOrEqual(0);
    const lines = source.slice(start).split('\n').slice(1);
    const bodies = new Map<string, string>();
    const entry = new RegExp(`^${indent}([a-z_]+):\\s*(.*)$`, 'u');
    let current: string | undefined;
    for (const line of lines) {
      if (new RegExp(`^${indent.slice(2)}\\}`, 'u').test(line)) break;
      const match = line.match(entry);
      if (match) {
        current = match[1];
        const shared = match[2].match(/^([A-Z_0-9]+),$/u)?.[1];
        bodies.set(current, shared ? sharedBody(source, shared) : line);
      } else if (current) bodies.set(current, `${bodies.get(current)}\n${line}`);
    }
    return bodies;
  }

  function sharedBody(source: string, name: string): string {
    const start = source.indexOf(`const ${name}`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n};', start);
    return source.slice(start, end);
  }

  it('declares every handler that reads or writes a step-supplied file', async () => {
    const { safeReadFile } = await import('@agent/core/secure-io');
    const { pathResolver } = await import('@agent/core/path-resolver');
    const { NATIVE_READ_PATH_OPS, NATIVE_WRITE_PATH_OPS } =
      await import('@agent/core/pipeline/run-manifest');
    const read = (file: string) =>
      String(
        safeReadFile(pathResolver.rootResolve(`libs/actuators/browser-actuator/src/${file}`), {
          encoding: 'utf8',
        })
      );
    const ops = read('browser-pipeline-op-handlers.ts');
    const control = read('browser-control-helpers.ts');
    const maps: Array<[Map<string, string>, string[]]> = [
      [
        handlerBodies(ops, /^const RAW_CAPTURE_HANDLERS/mu, '  '),
        Object.keys(BROWSER_CAPTURE_OP_HANDLERS),
      ],
      [
        handlerBodies(ops, /^export const BROWSER_TRANSFORM_OP_HANDLERS/mu, '  '),
        Object.keys(BROWSER_TRANSFORM_OP_HANDLERS),
      ],
      [
        handlerBodies(ops, /^const RAW_APPLY_HANDLERS/mu, '  '),
        Object.keys(BROWSER_APPLY_OP_HANDLERS),
      ],
      [
        handlerBodies(
          control,
          /const handlers: Record<string, \(\) => Promise<any>> = \{/u,
          '    '
        ),
        [...BROWSER_ACTUATOR_CONTROL_OPS],
      ],
    ];
    const touching: string[] = [];
    for (const [bodies, keys] of maps) {
      // The scan saw exactly the ops the engine can dispatch.
      expect([...bodies.keys()].sort()).toEqual([...keys].sort());
      for (const [op, body] of bodies) if (FILE_TOUCH.test(body)) touching.push(op);
    }
    const declared = new Set([
      ...NATIVE_WRITE_PATH_OPS,
      ...NATIVE_READ_PATH_OPS,
      ...Object.keys(NOT_A_FILE),
    ]);
    expect(touching.filter((op) => !declared.has(op))).toEqual([]);
    // Every declared write op is a real handler that touches a file.
    for (const op of NATIVE_WRITE_PATH_OPS) expect(touching, op).toContain(op);
    expect(touching).toEqual(expect.arrayContaining([...NATIVE_READ_PATH_OPS]));
  });
});

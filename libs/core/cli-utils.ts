import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';
import {
  defineActuator,
  planActuatorDryRun,
  resolveCliActionKind,
  type ActuatorDefinition,
} from './actuator-sdk.js';
import type { PipelineStepType } from './actuator-op-registry.js';
import { createAjv } from './foundation/ajv.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord, readTextFile } from './foundation/text.js';
import { assertCapabilityAllowed } from './capability-restriction-policy.js';

/**
 * Creates a pre-configured yargs instance with common options.
 */
export function createStandardYargs(args: string[]) {
  return yargs(hideBin(args))
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Input file or directory path',
    })
    .option('out', {
      alias: 'o',
      type: 'string',
      description: 'Output file path (optional)',
    })
    .option('tier', {
      type: 'string',
      choices: ['personal', 'confidential', 'public'],
      default: 'public',
      description: 'Knowledge tier for the operation',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      description:
        'Validate contract/params only for apply/transform/control. Capture still executes (always side-effect-free).',
    })
    .help('h')
    .alias('h', 'help');
}

/** Capture process arguments only at an explicit CLI boundary. */
export function currentProcessArgv(): string[] {
  return [...process.argv];
}

/**
 * Serve-mode framing: every response line is `PREFIX + JSON`, so clients
 * can pick results out of a stdout that also carries actuator logs.
 */
export const ACTUATOR_SERVE_RESULT_PREFIX = '@@kyberion-actuator-result@@';

export interface ActuatorServeRequest {
  id: string | null;
  input?: unknown;
}

export function normalizeActuatorServeRequest(value: unknown): ActuatorServeRequest {
  if (!isRecord(value)) throw new Error('actuator serve request must be a JSON object');
  if (value.id !== undefined && value.id !== null) {
    if (typeof value.id !== 'string' || !value.id.trim()) {
      throw new Error('actuator serve request.id must be a non-empty string');
    }
    return { id: value.id, input: value.input };
  }
  return { id: null, input: value.input };
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a package-local actuator entrypoint through one shared error boundary. */
export async function runActuatorCliEntryPoint(
  run: () => Promise<void>,
  name: string
): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    console.error(`[${name}] ${formatUnknownError(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Warm serve loop: NDJSON requests on stdin (`{"id":"r1","input":{...}}`),
 * one framed response line per request. Keeps the actuator process (and
 * any lazily-loaded engines) alive across requests — per-request process
 * startup is what makes one-shot voice synthesis slow.
 */
async function runActuatorServeLoop(opts: {
  name: string;
  actuator: ActuatorDefinition;
}): Promise<void> {
  const emit = (response: Record<string, unknown>): void => {
    process.stdout.write(`${ACTUATOR_SERVE_RESULT_PREFIX}${JSON.stringify(response)}\n`);
  };

  let buffer = '';
  for await (const data of process.stdin) {
    buffer += data.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let request: ActuatorServeRequest;
      try {
        const parsed: unknown = parseSafeJsonInput(line, 'actuator serve request');
        request = normalizeActuatorServeRequest(parsed);
      } catch (err: unknown) {
        emit({ ok: false, error: `invalid JSON request: ${formatUnknownError(err)}` });
        continue;
      }
      const id = request.id ?? null;
      const result = await opts.actuator.dispatch('execute', request.input);
      emit(
        result.ok
          ? { id, ok: true, result: result.output }
          : { id, ok: false, error: result.error || 'actuator execution failed' }
      );
    }
  }
}

export async function runActuatorCli(opts: {
  name: string;
  handleAction?: (input: unknown) => Promise<unknown> | unknown;
  schema?: object;
  /** Reuse an already-defined SDK actuator instead of creating a CLI-only ABI. */
  actuator?: ActuatorDefinition;
  /** Override inner action kind for handleAction-style CLIs (get/list stay capture). */
  resolveOpKind?: (input: unknown) => PipelineStepType;
  printResult?: (result: unknown) => void;
  args: string[];
}): Promise<void> {
  assertCapabilityAllowed(opts.name);
  const actuator =
    opts.actuator ||
    (() => {
      if (!opts.handleAction) {
        throw new Error('runActuatorCli requires handleAction when actuator is not provided');
      }
      const schemaValidator = opts.schema ? createAjv().compile(opts.schema) : undefined;
      return defineActuator({
        id: opts.name,
        ops: {
          execute: {
            kind: 'apply',
            ...(opts.schema ? { input_schema: opts.schema } : {}),
            ...(schemaValidator
              ? {
                  validateInput: (input: unknown): unknown => {
                    if (!schemaValidator(input)) {
                      const details = (schemaValidator.errors || [])
                        .map(
                          (error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`
                        )
                        .join('; ');
                      throw new Error(`invalid input: ${details}`);
                    }
                    return input;
                  },
                }
              : {}),
            handler: (input: unknown, context) => {
              const kind = resolveCliActionKind(input, opts.resolveOpKind);
              const plan = planActuatorDryRun({
                kind,
                dryRun: context.dryRun === true,
              });
              if (plan.skipHandler) {
                return {
                  dry_run: true,
                  mode: plan.mode,
                  kind,
                  validated: true,
                };
              }
              return opts.handleAction!(input);
            },
          },
        },
      });
    })();
  const argv = await createStandardYargs(opts.args)
    .option('input', { alias: 'i', type: 'string' })
    .option('serve', {
      type: 'boolean',
      default: false,
      description: 'Stay resident: read NDJSON requests from stdin (warm actuator mode)',
    })
    .parse();

  if (argv.serve) {
    await runActuatorServeLoop({ name: opts.name, actuator });
    return;
  }

  if (!argv.input) {
    console.error(`[${opts.name}] --input is required (or use --serve)`);
    throw new Error('--input is required (or use --serve)');
  }
  const inputPath = assertSafeRepositoryPath(pathResolver.rootResolve(String(argv.input)), {
    allowMissingLeaf: true,
  });

  let inputContent: string;
  try {
    inputContent = readTextFile(inputPath);
  } catch (err: any) {
    console.error(`[${opts.name}] failed to read input: ${err?.message || err}`);
    throw new Error(`failed to read input: ${err?.message || err}`);
  }

  let input: unknown;
  try {
    input = parseSafeJsonInput(inputContent, `${opts.name} input`);
  } catch (err: any) {
    console.error(`[${opts.name}] invalid JSON input: ${err?.message || err}`);
    throw new Error(`invalid JSON input: ${err?.message || err}`);
  }

  const dryRun = argv.dryRun === true;
  const result = await actuator.dispatch('execute', input, {
    dryRun,
    dryRunKind: resolveCliActionKind(input, opts.resolveOpKind),
  });
  if (!result.ok) {
    const error = result.error || 'unknown error';
    const label = error.startsWith('invalid input:') ? 'invalid input' : 'handleAction failed';
    console.error(
      `[${opts.name}] ${label}${label === 'invalid input' ? `: ${error.slice('invalid input:'.length).trim()}` : `: ${error}`}`
    );
    throw new Error(`${label}: ${error}`);
  }
  (opts.printResult || ((value) => console.log(JSON.stringify(value, null, 2))))(result.output);
}

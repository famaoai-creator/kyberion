import AjvModule from 'ajv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

/**
 * Creates a pre-configured yargs instance with common options.
 */
export function createStandardYargs(args = process.argv) {
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
    .help('h')
    .alias('h', 'help');
}

/**
 * Serve-mode framing: every response line is `PREFIX + JSON`, so clients
 * can pick results out of a stdout that also carries actuator logs.
 */
export const ACTUATOR_SERVE_RESULT_PREFIX = '@@kyberion-actuator-result@@';

interface ActuatorServeRequest {
  id?: unknown;
  input?: unknown;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Warm serve loop: NDJSON requests on stdin (`{"id":"r1","input":{...}}`),
 * one framed response line per request. Keeps the actuator process (and
 * any lazily-loaded engines) alive across requests — per-request process
 * startup is what makes one-shot voice synthesis slow.
 */
async function runActuatorServeLoop(opts: {
  name: string;
  handleAction: (input: unknown) => Promise<unknown> | unknown;
  schema?: object;
}): Promise<void> {
  const validate = opts.schema
    ? new Ajv({ allErrors: true, allowUnionTypes: true }).compile(opts.schema)
    : null;
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
        request = JSON.parse(line) as ActuatorServeRequest;
      } catch (err: unknown) {
        emit({ ok: false, error: `invalid JSON request: ${formatUnknownError(err)}` });
        continue;
      }
      const id = request.id ?? null;
      if (validate && !validate(request.input)) {
        const details = (validate.errors || [])
          .map((error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
          .join('; ');
        emit({ id, ok: false, error: `invalid input: ${details}` });
        continue;
      }
      try {
        const result = await opts.handleAction(request.input);
        emit({ id, ok: true, result });
      } catch (err: unknown) {
        emit({ id, ok: false, error: formatUnknownError(err) });
      }
    }
  }
}

export async function runActuatorCli(opts: {
  name: string;
  handleAction: (input: unknown) => Promise<unknown> | unknown;
  schema?: object;
  printResult?: (result: unknown) => void;
  args?: string[];
}): Promise<void> {
  const argv = await createStandardYargs(opts.args || process.argv)
    .option('input', { alias: 'i', type: 'string' })
    .option('serve', {
      type: 'boolean',
      default: false,
      description: 'Stay resident: read NDJSON requests from stdin (warm actuator mode)',
    })
    .parse();

  if (argv.serve) {
    await runActuatorServeLoop({
      name: opts.name,
      handleAction: opts.handleAction,
      ...(opts.schema ? { schema: opts.schema } : {}),
    });
    return;
  }

  if (!argv.input) {
    console.error(`[${opts.name}] --input is required (or use --serve)`);
    process.exit(1);
    return;
  }
  const inputPath = pathResolver.rootResolve(String(argv.input));

  let inputContent: string;
  try {
    inputContent = String(safeReadFile(inputPath, { encoding: 'utf8' }) || '');
  } catch (err: any) {
    console.error(`[${opts.name}] failed to read input: ${err?.message || err}`);
    process.exit(1);
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(inputContent);
  } catch (err: any) {
    console.error(`[${opts.name}] invalid JSON input: ${err?.message || err}`);
    process.exit(1);
    return;
  }

  if (opts.schema) {
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    const validate = ajv.compile(opts.schema);
    if (!validate(input)) {
      const details = (validate.errors || [])
        .map((error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
        .join('; ');
      console.error(`[${opts.name}] invalid input: ${details}`);
      process.exit(1);
      return;
    }
  }

  try {
    const result = await opts.handleAction(input);
    (opts.printResult || ((value) => console.log(JSON.stringify(value, null, 2))))(result);
  } catch (err: any) {
    console.error(`[${opts.name}] handleAction failed: ${err?.message || err}`);
    process.exit(1);
  }
}

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

export async function runActuatorCli(opts: {
  name: string;
  handleAction: (input: unknown) => Promise<unknown> | unknown;
  schema?: object;
  printResult?: (result: unknown) => void;
  args?: string[];
}): Promise<void> {
  const argv = await createStandardYargs(opts.args || process.argv)
    .option('input', { alias: 'i', type: 'string', required: true })
    .parse();
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

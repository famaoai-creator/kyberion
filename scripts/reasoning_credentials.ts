import {
  listReasoningApiProviders,
  requireReasoningApiProvider,
  requireReasoningApiProofAdapter,
  isReasoningApiModel,
  resolveReasoningApiModel,
  resolveReasoningApiKey,
  verifyReasoningApiCredential,
} from '@agent/core/reasoning/reasoning-api-credentials';
import { pathResolver } from '@agent/core/path-resolver';
import { writeJson } from '@agent/core/foundation/json';
import { hasHelpFlag } from './lib/cli-guard.js';
import { physicalScopedPath } from '@agent/core/physical-namespace';
import { currentScope } from '@agent/core/scope-context';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { runSecretCli } from './secret_introduce.js';
import {
  persistReasoningBackend,
  persistEnvValue,
  readPersistedEnvValue,
} from './reasoning_backend_selection.js';

export function parseCredentialArgs(args: string[]) {
  const argv = args.filter((arg) => !['--', '--json', '--quiet'].includes(arg));
  if (!argv.length || hasHelpFlag(argv)) return { action: 'help' as const };
  const action = argv.shift();
  if (!['register', 'status', 'verify'].includes(action ?? ''))
    throw new Error('Choose register, status, or verify.');
  let provider = '';
  let model: string | undefined;
  let activate = false;
  let allowPaid = false;
  const seen = new Set<string>();
  while (argv.length) {
    const flag = argv.shift()!;
    if (seen.has(flag)) throw new Error('Duplicate option.');
    seen.add(flag);
    if (flag === '--provider') provider = argv.shift() ?? '';
    else if (flag === '--model') model = argv.shift();
    else if (flag === '--activate') activate = true;
    else if (flag === '--allow-paid') allowPaid = true;
    else throw new Error('Unknown option. Never put a key on argv.');
  }
  requireReasoningApiProvider(provider);
  if (model && !isReasoningApiModel(model)) throw new Error('Invalid model.');
  if (action !== 'register' && activate) throw new Error('--activate is only valid for register.');
  if (action !== 'verify' && allowPaid) throw new Error('--allow-paid is only valid for verify.');
  if (action === 'status' && model) throw new Error('--model is not valid for status.');
  if (action === 'verify' && !model) throw new Error('Verification requires --model.');
  return { action, provider, model, activate, allowPaid };
}

export async function runCredentialCommand(
  args: string[],
  print: (value: string) => void = console.log
): Promise<number> {
  const options = parseCredentialArgs(args);
  if (options.action === 'help') {
    print(
      'pnpm kyberion reasoning credentials register|status|verify --provider <provider> [--model <model>] [--activate] [--allow-paid]'
    );
    print(
      `Providers: ${listReasoningApiProviders()
        .map((provider) => provider.mode)
        .join(', ')}`
    );
    print(
      'Registration uses the governed secret introduction flow and hidden terminal input. Verification sends one synthetic request (128 output tokens); --allow-paid authorizes possible charges.'
    );
    return 0;
  }
  const descriptor = requireReasoningApiProvider(options.provider);
  if (options.action === 'status') {
    let configured = false;
    try {
      configured = Boolean(resolveReasoningApiKey(options.provider));
    } catch {
      /* metadata only */
    }
    print(JSON.stringify({ provider: options.provider, configured, verified: false }));
    return configured ? 0 : 1;
  }
  requireReasoningApiProofAdapter(options.provider);
  if (options.action === 'register') {
    const keys = descriptor.model_env_keys ?? [];
    const model = resolveReasoningApiModel(
      options.provider,
      options.model ||
        keys.map((key) => process.env[key]?.trim()).find(Boolean) ||
        keys.map((key) => readPersistedEnvValue(key)).find(Boolean)
    );
    if (options.activate && (!model || !isReasoningApiModel(model)))
      throw new Error('Select a model or configure an existing model before activation.');
    const identity = descriptor.secret_refs![0]!;
    const result = await runSecretCli(
      ['introduce', identity.service_id, identity.secret_key, '--json'],
      { print }
    );
    if (result.status !== 'applied') return 1;
    if (options.model && keys[0]) persistEnvValue(keys[0], options.model);
    const urlEnv = descriptor.api_proof?.runtime_url_env;
    if (
      options.activate &&
      urlEnv &&
      !process.env[urlEnv]?.trim() &&
      !readPersistedEnvValue(urlEnv)
    )
      persistEnvValue(urlEnv, descriptor.api_proof!.base_url);
    if (options.activate) persistReasoningBackend(descriptor.mode);
    print(
      JSON.stringify({
        provider: options.provider,
        status: 'registered',
        activated: options.activate,
        verified: false,
      })
    );
    return 0;
  }
  const result = await verifyReasoningApiCredential({
    provider: options.provider,
    model: options.model!,
    allowPaid: options.allowPaid,
  });
  writeJson(
    physicalScopedPath(
      pathResolver.shared('runtime/health/api-verification'),
      currentScope(),
      `${options.provider}.json`
    ),
    result
  );
  print(JSON.stringify(result));
  return result.status === 'success' ? 0 : 1;
}
export const runReasoningCredentials = defineScript({
  name: 'reasoning:credentials',
  flags: ['json', 'quiet'],
  run: async ({ argv, print }) => {
    try {
      const code = await runCredentialCommand(argv, (value) => print(value));
      if (code)
        throw new ScriptExitError(
          code,
          'API credentials are not verified; inspect the metadata result or complete the secret introduction approval.'
        );
    } catch (error) {
      if (error instanceof ScriptExitError) throw error;
      throw new ScriptExitError(
        1,
        'Credential command failed. Check provider/model configuration, terminal access, secret permissions, and --help.'
      );
    }
  },
});
if (
  isDirectScript(import.meta.url, 'reasoning_credentials.ts') ||
  isDirectScript(import.meta.url, 'reasoning_credentials.js')
)
  void runReasoningCredentials();

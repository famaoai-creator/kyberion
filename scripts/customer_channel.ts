/**
 * customer_channel.ts — the governed command for a tenant's customer channel
 * bindings (`customer/<tenant>/connections/channel-bindings.json`, E2E-06 / D8)
 * and for reading a customer message that waits for approval (CD-11 / B2).
 *
 *   bind     --tenant <slug> --surface <slack|telegram|email|imessage|discord> --channel <id>
 *            [--name <text>] [--org <text>] [--language <tag>] [--mode sales|support|requirements_hearing]
 *            create, update or reactivate the binding (the tenant must be registered and active)
 *   unbind   --tenant <slug> --surface <s> --channel <id>    deactivate it (kept, `active: false`)
 *   list     --tenant <slug>                                 the tenant's bindings, inactive included
 *   outbound --tenant <slug> --source <deals/<deal>/<quote|contract>-v<n>.md> [--sha256 <hex>]
 *            show a pending customer message from the tenant's own copy; with --sha256 (from the
 *            approval request summary) also whether it is exactly the text the approval binds
 *   question --tenant <slug> --deal <id> --sha256 <hex>
 *            show an escalated customer message (the operator notification carries only its hash)
 *
 * Every change is validated against customer-channel-binding.schema.json and
 * recorded in the tenant's audit chain. The approval store only ever carries
 * ids; the message is read here, from the tenant's tree.
 */
import {
  isActiveCustomerTenant,
  readTenantCustomerChannelBindings,
} from '@agent/core/customer-channel-binding';
import {
  bindCustomerChannel,
  unbindCustomerChannel,
  type CustomerChannelBindingChange,
} from './customer-channel/bindings.js';
import {
  readCustomerOutboundContent,
  readCustomerQuestion,
} from '@agent/core/customer-conversation';
import { boundTenant } from '@agent/core/owner-scope';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';

const USAGE = [
  'customer-channel bind --tenant <slug> --surface <s> --channel <id> [--name <text>] [--org <text>] [--language <tag>] [--mode sales|support|requirements_hearing]',
  'customer-channel unbind --tenant <slug> --surface <s> --channel <id>',
  'customer-channel list --tenant <slug>',
  'customer-channel outbound --tenant <slug> --source <deals/<deal>/<quote|contract>-v<n>.md> [--sha256 <hex>]',
  'customer-channel question --tenant <slug> --deal <id> --sha256 <hex>',
].join('\n');

const VALUE_OPTIONS = new Set([
  'tenant',
  'surface',
  'channel',
  'name',
  'org',
  'language',
  'mode',
  'source',
  'sha256',
  'deal',
]);

function usageError(message: string): ScriptExitError {
  return new ScriptExitError(2, `${message}\n${USAGE}`);
}

export function parseCustomerChannelArgs(argv: readonly string[]): {
  verb: string;
  opts: Record<string, string>;
} {
  const [verb = 'help', ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const key = arg.startsWith('--') ? arg.slice(2) : '';
    if (!VALUE_OPTIONS.has(key)) throw usageError(`unknown argument '${arg}'`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw usageError(`--${key} needs a value`);
    if (Object.hasOwn(opts, key)) throw usageError(`--${key} given twice`);
    opts[key] = value;
    index += 1;
  }
  return { verb, opts };
}

function requireOpt(opts: Record<string, string>, key: string): string {
  const value = opts[key];
  if (value === undefined || value.trim() === '') throw usageError(`--${key} is required`);
  return value;
}

/**
 * `--tenant`, which never overrides the tenant this process is bound to
 * (`KYBERION_TENANT`): a mismatch is refused, like the mission state readers.
 */
function tenantOpt(opts: Record<string, string>): string {
  const requested = requireOpt(opts, 'tenant').trim();
  const bound = boundTenant();
  if (bound && requested.toLowerCase() !== bound) {
    throw new ScriptExitError(
      2,
      `[CUSTOMER_CHANNEL_TENANT_MISMATCH] --tenant ${requested} differs from the bound tenant ${bound}`
    );
  }
  return requested;
}

function change(opts: Record<string, string>): CustomerChannelBindingChange {
  return {
    tenantSlug: tenantOpt(opts),
    surface: requireOpt(opts, 'surface'),
    channelId: requireOpt(opts, 'channel'),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.org !== undefined ? { org: opts.org } : {}),
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  };
}

/** Governance refusals (`[CODE] message`) are exit 2 with the message; anything else rethrows. */
function governed<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^\[CUSTOMER_BINDING_[A-Z_]+\]/u.test(message)) throw new ScriptExitError(2, message);
    throw error;
  }
}

export function runCustomerChannel(argv: readonly string[]): unknown {
  const { verb, opts } = parseCustomerChannelArgs(argv);
  switch (verb) {
    case 'help':
    case '--help':
    case '-h':
      return { usage: USAGE };
    case 'bind':
      return governed(() => bindCustomerChannel(change(opts)));
    case 'unbind': {
      const target = change(opts);
      for (const key of ['name', 'org', 'language', 'mode'] as const) {
        if (opts[key] !== undefined) throw usageError(`unbind takes no --${key}`);
      }
      const result = governed(() => unbindCustomerChannel(target));
      if (!result) {
        throw new ScriptExitError(
          2,
          `${target.surface}:${target.channelId} is not bound for tenant ${target.tenantSlug}`
        );
      }
      return result;
    }
    case 'list': {
      const tenant = tenantOpt(opts);
      return { tenant_slug: tenant, bindings: readTenantCustomerChannelBindings(tenant) };
    }
    case 'outbound': {
      const tenant = tenantOpt(opts);
      const source = requireOpt(opts, 'source');
      const expected = opts.sha256?.toLowerCase();
      if (expected !== undefined && !/^[a-f0-9]{64}$/u.test(expected)) {
        throw usageError('--sha256 must be 64 hex characters');
      }
      // Only a registered, active tenant's own tree; the source names a deal document.
      const content = !isActiveCustomerTenant(tenant)
        ? null
        : readCustomerOutboundContent({
            tenantSlug: tenant,
            source,
            ...(expected !== undefined ? { expectedSha256: expected } : {}),
          });
      if (!content) {
        throw new ScriptExitError(
          2,
          `no readable outbound content ${source} for tenant ${tenant} (only customer/<tenant>/deals/<deal>/<quote|contract>-v<n>.md)`
        );
      }
      return {
        tenant_slug: tenant,
        source,
        sha256: content.sha256,
        ...(content.matches === null ? {} : { matches_approval: content.matches }),
        text: content.text,
      };
    }
    case 'question': {
      const tenant = tenantOpt(opts);
      const dealId = requireOpt(opts, 'deal');
      const sha256 = requireOpt(opts, 'sha256').toLowerCase();
      if (!/^[a-f0-9]{64}$/u.test(sha256)) throw usageError('--sha256 must be 64 hex characters');
      const question = isActiveCustomerTenant(tenant)
        ? readCustomerQuestion({ tenantSlug: tenant, dealId, sha256 })
        : null;
      if (!question) {
        throw new ScriptExitError(
          2,
          `no customer message ${sha256} on deal ${dealId} of tenant ${tenant}`
        );
      }
      return { tenant_slug: tenant, ...question };
    }
    default:
      throw usageError(`unknown verb '${verb}'`);
  }
}

export const runCustomerChannelScript = defineScript({
  name: 'customer-channel',
  flags: ['json'],
  run: (context) => {
    const result = runCustomerChannel(context.argv.filter((arg) => arg !== '--json'));
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'customer_channel.ts') ||
  isDirectScript(import.meta.url, 'customer_channel.js')
) {
  void runCustomerChannelScript(currentProcessArgv().slice(2));
}

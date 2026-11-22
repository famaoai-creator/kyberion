/**
 * `pnpm kyberion ops` — cross-actuator op vocabulary discovery.
 *
 *   ops                        List every actuator domain with op counts
 *   ops <domain> [--kind <k>]  List that domain's ops grouped by step kind
 *
 * Vocabulary comes from the governed actuator-op-registry — the same source
 * pipeline authors validate `system:*`/`browser:*` step ops against.
 */
import { listOpDomains, loadOpDomain } from '../lib/actuator-op-registry.js';
import { ScriptExitError } from '../lib/harness.js';

const OPS_USAGE = `Usage: pnpm kyberion ops [domain] [--kind capture|transform|apply|control]

  ops                 List actuator domains and op counts
  ops <domain>        List that domain's ops grouped by kind (system, browser, …)`;

export async function runOpsCommand(args: string[], print: (line: string) => void): Promise<void> {
  const positionals: string[] = [];
  let kindFilter: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--kind') {
      kindFilter = args[i + 1];
      i += 1;
    } else if (arg === '--help') {
      print(OPS_USAGE);
      return;
    } else if (!arg.startsWith('--')) {
      positionals.push(arg);
    } else {
      throw new ScriptExitError(1, `unknown option ${arg}\n\n${OPS_USAGE}`);
    }
  }

  if (kindFilter && !['capture', 'transform', 'apply', 'control'].includes(kindFilter)) {
    throw new ScriptExitError(
      1,
      `--kind must be capture|transform|apply|control (got '${kindFilter}')\n\n${OPS_USAGE}`
    );
  }

  const domains = listOpDomains();
  const [domain] = positionals;
  if (!domain) {
    const summary = Object.fromEntries(
      domains.map((name) => {
        const section = loadOpDomain(name);
        return [name, section ? Object.keys(section.kinds).length : 0];
      })
    );
    print(JSON.stringify(summary, null, 2));
    return;
  }

  const section = loadOpDomain(domain);
  if (!section) {
    throw new ScriptExitError(
      1,
      `unknown actuator domain '${domain}' — domains: ${domains.join(', ')}`
    );
  }
  const grouped: Record<string, string[]> = {};
  for (const [kind, ops] of Object.entries(section.byKind)) {
    if (kindFilter && kind !== kindFilter) continue;
    if (ops.length > 0) grouped[kind] = ops;
  }
  print(JSON.stringify({ domain, ...grouped }, null, 2));
}

import { withExecutionContext } from '@agent/core/governance';
import {
  FIRST_RUN_CODE_DEFAULT_TTL_MINUTES,
  issueFirstRunSetupCode,
  readFirstRunStatus,
} from '@agent/core/surface/first-run-setup';

type Print = (value: string) => void;

export const FIRST_RUN_DEFAULT_URL = 'http://localhost:3050';
const FIRST_RUN_PATH = '/setup/first-run';

const HELP = [
  'Usage: pnpm organization first-run <code|status> [options]',
  '',
  'First-run setup lets a browser create the owner, receive an access token and',
  'configure SSO on Concierge before any owner can sign in. It is open only',
  'until an owner holds a token or a bound IdP identity.',
  '',
  '  code     Issue (or replace) the one-time setup code and print the setup URL',
  '  status   Show whether first-run setup is still open',
  '',
  'Options (code):',
  `  --ttl-minutes <n>   Code lifetime, 1-1440 (default ${FIRST_RUN_CODE_DEFAULT_TTL_MINUTES})`,
  `  --url <origin>      Concierge origin the browser uses (default ${FIRST_RUN_DEFAULT_URL})`,
].join('\n');

export type FirstRunCommand =
  { action: 'code'; ttlMinutes?: number; url: string } | { action: 'status' };

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value.trim();
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--url must be an absolute http(s) origin');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('--url must be an absolute http(s) origin');
  }
  return url.origin;
}

export function parseFirstRunCommand(args: string[]): FirstRunCommand | null {
  const [action, ...rest] = args;
  if (!action || action === '--help' || action === 'help') return null;
  if (action === 'status') return { action };
  if (action !== 'code') throw new Error(`unknown first-run command '${action}'`);
  const ttlText = readFlag(rest, '--ttl-minutes');
  const ttlMinutes = ttlText === undefined ? undefined : Number(ttlText);
  if (ttlMinutes !== undefined && !Number.isInteger(ttlMinutes)) {
    throw new Error('--ttl-minutes must be an integer');
  }
  const urlText = readFlag(rest, '--url');
  return {
    action,
    ...(ttlMinutes !== undefined ? { ttlMinutes } : {}),
    url: urlText ? parseOrigin(urlText) : FIRST_RUN_DEFAULT_URL,
  };
}

/** `pnpm organization first-run ...` — governed first-run setup bootstrap. */
export async function runOrganizationFirstRun(
  args: string[],
  print: Print = (value) => process.stdout.write(`${value}\n`)
): Promise<void> {
  const command = parseFirstRunCommand(args);
  if (!command) {
    print(HELP);
    return;
  }
  if (command.action === 'status') {
    const status = withExecutionContext('sovereign_concierge', () => readFirstRunStatus());
    print(JSON.stringify(status, null, 2));
    return;
  }
  const issued = withExecutionContext('sovereign_concierge', () =>
    issueFirstRunSetupCode(
      command.ttlMinutes !== undefined ? { ttlMinutes: command.ttlMinutes } : {}
    )
  );
  // The code rides in the URL fragment so it never reaches server or proxy logs.
  print(
    [
      `First-run setup code: ${issued.code}`,
      `Expires at: ${issued.expires_at}`,
      '',
      `Open: ${command.url}${FIRST_RUN_PATH}#code=${issued.code}`,
      '',
      'The code works once. Issuing a new code replaces this one.',
    ].join('\n')
  );
}

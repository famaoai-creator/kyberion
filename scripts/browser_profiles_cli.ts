/**
 * Kyberion Browser Profiles CLI
 *
 * Inspect and manage profiles across Chrome, Playwright, and other browsers.
 *
 * Usage:
 *   pnpm kyberion browser profiles [--provider chrome|playwright|all] [--json]
 *   pnpm kyberion browser open <url> [--profile <name|id|email>] [--provider chrome|playwright]
 */

import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  createPlaywrightProfile,
  type BrowserProfile,
  type BrowserProvider,
} from '../libs/actuators/browser-actuator/src/browser-profile-manager.js';
import {
  discoverBrowserProfiles,
  resolveRegisteredBrowserProfile,
  openRegisteredBrowserProfile,
} from '../libs/actuators/browser-actuator/src/browser-profile-provider-registry.js';

function formatTable(profiles: BrowserProfile[]): string {
  if (profiles.length === 0) {
    return 'No browser profiles found.';
  }

  const headers = ['Provider', 'ID', 'Name', 'Account/Email', 'Status', 'Path'];
  const rows = profiles.map((p) => [
    p.provider,
    p.id,
    p.name,
    p.email || '-',
    p.status.toUpperCase(),
    p.userDataDir,
  ]);

  const colWidths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] || '').length))
  );

  const formatRow = (cols: string[]) => cols.map((col, i) => col.padEnd(colWidths[i])).join('  ');

  const separator = colWidths.map((w) => '-'.repeat(w)).join('  ');

  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n');
}

export async function openProfileUrl(
  profile: BrowserProfile,
  url: string,
  options: { print?: (msg: string) => void } = {}
): Promise<void> {
  await openRegisteredBrowserProfile(profile, url, options.print || console.log);
}

export async function main(argv: string[], print: (msg: string) => void): Promise<void> {
  const normalizedArgs = argv.filter((arg) => arg !== '--');
  const parser = createStandardYargs(['node', 'browser_profiles_cli', ...normalizedArgs])
    .command('profiles', 'List all browser profiles across providers')
    .command('open [url]', 'Open a URL using a specific browser profile')
    .command('create <name>', 'Create a new isolated Playwright browser profile')
    .option('provider', {
      type: 'string',
      description: 'Filter by registered provider ID, or all',
      default: 'all',
    })
    .option('profile', {
      type: 'string',
      alias: 'p',
      description: 'Profile name, ID, or email address',
    })
    .option('email', {
      type: 'string',
      description: 'Email address associated with the profile',
    })
    .option('engine', {
      type: 'string',
      choices: ['chromium', 'firefox', 'webkit'],
      default: 'chromium',
      description: 'Browser engine for Playwright profile',
    })
    .option('json', {
      type: 'boolean',
      description: 'Output results as JSON',
      default: false,
    })
    .help();

  const parsed = await parser.parse();
  const subCommand = parsed._[0] as string | undefined;

  if (subCommand === 'create') {
    const name = (parsed.name as string) || (parsed._[1] as string);
    if (!name) {
      throw new ScriptExitError(
        1,
        'Missing profile name. Usage: pnpm kyberion browser profile create <name>'
      );
    }
    const profile = createPlaywrightProfile(name, {
      email: parsed.email as string | undefined,
      engine: parsed.engine as any,
    });
    if (parsed.json) {
      print(JSON.stringify(profile, null, 2));
    } else {
      print(`[browser-cli] Successfully created Playwright profile:`);
      print(`  ID:       ${profile.id}`);
      print(`  Name:     ${profile.name}`);
      print(`  Email:    ${profile.email || '-'}`);
      print(`  Path:     ${profile.userDataDir}`);
      print(`\nYou can now use this profile with:`);
      print(`  pnpm kyberion browser open <url> --profile "${profile.name}"`);
    }
    return;
  }

  if (subCommand === 'open') {
    const url = (parsed.url as string) || (parsed._[1] as string);
    if (!url) {
      throw new ScriptExitError(1, 'Missing URL argument. Usage: pnpm kyberion browser open <url>');
    }

    const provider = parsed.provider as BrowserProvider | 'all';
    const profileQuery = parsed.profile as string | undefined;

    let targetProfile: BrowserProfile | undefined;
    if (profileQuery) {
      targetProfile = await resolveRegisteredBrowserProfile({
        provider: provider !== 'all' ? provider : undefined,
        profile: profileQuery,
      });
      if (!targetProfile) {
        throw new ScriptExitError(
          1,
          `Could not find browser profile matching query: "${profileQuery}"`
        );
      }
    } else {
      // Pick default profile or first available
      const profiles = await discoverBrowserProfiles({
        provider: provider !== 'all' ? provider : undefined,
      });
      targetProfile = profiles.find((p) => p.isDefault) || profiles[0];
      if (!targetProfile) {
        throw new ScriptExitError(1, 'No browser profile available.');
      }
    }

    await openProfileUrl(targetProfile, url, { print });
    return;
  }

  // Default: list profiles
  const provider = parsed.provider as BrowserProvider | 'all';
  const profiles = await discoverBrowserProfiles({
    provider: provider !== 'all' ? provider : undefined,
  });

  if (parsed.json) {
    print(JSON.stringify(profiles, null, 2));
  } else {
    print(`[browser-cli] Discovered ${profiles.length} browser profile(s):\n`);
    print(formatTable(profiles));
  }
}

export const browserProfilesCli = defineScript({
  name: 'browser-profiles-cli',
  flags: ['json', 'quiet'],
  async run(context) {
    await main(context.argv, context.print);
  },
});

if (
  isDirectScript(import.meta.url, 'browser_profiles_cli.ts') ||
  isDirectScript(import.meta.url, 'browser_profiles_cli.js')
) {
  void browserProfilesCli();
}

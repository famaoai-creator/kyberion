/**
 * Kyberion Browser Profiles CLI
 *
 * Inspect and manage profiles across Chrome, Playwright, and other browsers.
 *
 * Usage:
 *   pnpm kyberion browser profiles [--provider chrome|playwright|all] [--json]
 *   pnpm kyberion browser open <url> [--profile <name|id|email>] [--provider chrome|playwright]
 */

import { safeExecResultAsync } from '@agent/core/secure-io';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  listBrowserProfiles,
  resolveBrowserProfile,
  createPlaywrightProfile,
  type BrowserProfile,
  type BrowserProvider,
} from '../libs/actuators/browser-actuator/src/browser-profile-manager.js';

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
  const print = options.print || console.log;

  if (profile.provider === 'chrome') {
    if (process.platform === 'darwin') {
      const args = [
        '-b',
        'com.google.Chrome',
        '--args',
        `--profile-directory=${profile.profileDirectory || profile.id}`,
        url,
      ];
      print(`[browser-cli] Opening ${url} in Chrome (${profile.name} [${profile.id}])...`);
      const result = await safeExecResultAsync('open', args);
      if (result.status !== 0) {
        throw new Error(`Failed to open URL in Chrome: ${result.stderr}`);
      }
      return;
    }

    if (process.platform === 'win32') {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const args = [`--profile-directory=${profile.profileDirectory || profile.id}`, url];
      print(`[browser-cli] Opening ${url} in Chrome (${profile.name})...`);
      const result = await safeExecResultAsync(chromePath, args);
      if (result.status !== 0) {
        throw new Error(`Failed to open URL in Chrome: ${result.stderr}`);
      }
      return;
    }

    // Linux
    const args = [`--profile-directory=${profile.profileDirectory || profile.id}`, url];
    print(`[browser-cli] Opening ${url} in Chrome (${profile.name})...`);
    const result = await safeExecResultAsync('google-chrome', args);
    if (result.status !== 0) {
      throw new Error(`Failed to open URL in Chrome: ${result.stderr}`);
    }
    return;
  }

  // Playwright managed profile
  print(
    `[browser-cli] Opening ${url} with Playwright profile (${profile.name} at ${profile.userDataDir})...`
  );
  // Dynamically load playwright to avoid strict dependency in non-browser environments
  try {
    const { chromium } = await import('@playwright/test');
    const context = await chromium.launchPersistentContext(profile.userDataDir, {
      headless: false,
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url);
    print(`[browser-cli] URL opened in Playwright browser session.`);
  } catch (err: any) {
    throw new Error(`Failed to launch Playwright with profile: ${err.message}`);
  }
}

export async function main(argv: string[], print: (msg: string) => void): Promise<void> {
  const normalizedArgs = argv.filter((arg) => arg !== '--');
  const parser = createStandardYargs(['node', 'browser_profiles_cli', ...normalizedArgs])
    .command('profiles', 'List all browser profiles across providers')
    .command('open [url]', 'Open a URL using a specific browser profile')
    .command('create <name>', 'Create a new isolated Playwright browser profile')
    .option('provider', {
      type: 'string',
      description: 'Filter by provider (chrome, playwright, all)',
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
      targetProfile = resolveBrowserProfile({
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
      const profiles = listBrowserProfiles({
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
  const profiles = listBrowserProfiles({
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

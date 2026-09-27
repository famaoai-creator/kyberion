#!/usr/bin/env node
/* eslint-disable no-restricted-imports, no-restricted-syntax -- Host-level profile manager owns ~/.codex-profiles and launches the provider CLI. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { getRegisteredEnvText } from '@agent/core/foundation';
import {
  assertValidCodexProfileName,
  codexProfileRoot,
  resolveCodexHome,
  resolveCodexProfileName,
} from '@agent/core';

type Print = (value: unknown) => void;

function profilePath(name: string): string {
  const root = path.resolve(codexProfileRoot());
  const candidate = path.resolve(root, name);
  if (!candidate.startsWith(`${root}${path.sep}`))
    throw new ScriptExitError(1, 'Invalid Codex profile path.');
  return candidate;
}

function hasStoredAuth(home: string): boolean {
  return fs.existsSync(path.join(home, 'auth.json'));
}

export function listProfiles(): {
  name: string;
  path: string;
  authenticated: boolean;
  active: boolean;
}[] {
  const defaultHome = resolveCodexHome('default');
  const active = resolveCodexProfileName() || 'default';
  const profiles = [
    {
      name: 'default',
      path: defaultHome,
      authenticated: hasStoredAuth(defaultHome),
      active: active === 'default',
    },
  ];
  const root = codexProfileRoot();
  if (!fs.existsSync(root)) return profiles;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const profile = profilePath(entry.name);
    profiles.push({
      name: entry.name,
      path: profile,
      authenticated: hasStoredAuth(profile),
      active: active === entry.name,
    });
  }
  return profiles;
}

export function addProfile(name: string, print: Print = console.log): string {
  try {
    assertValidCodexProfileName(name);
  } catch (error) {
    throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
  }
  const target = profilePath(name);
  if (fs.existsSync(target))
    throw new ScriptExitError(1, `Profile '${name}' already exists at ${target}`);
  fs.mkdirSync(target, { recursive: true });
  print(`Profile '${name}' created successfully at: ${target}`);
  print('To authenticate with ChatGPT for this profile:');
  print(`  pnpm kyberion codex profile login ${name}`);
  return target;
}

export function deleteProfile(name: string, print: Print = console.log): void {
  try {
    assertValidCodexProfileName(name);
  } catch (error) {
    throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
  }
  const target = profilePath(name);
  if (!fs.existsSync(target))
    throw new ScriptExitError(1, `Profile '${name}' not found at ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  print(`Profile '${name}' deleted.`);
}

export async function runCodexCommand(
  action: 'login' | 'run',
  profileName: string,
  extraArgs: string[] = []
): Promise<number> {
  if (!profileName) throw new ScriptExitError(1, `Profile name required for ${action}.`);
  const target = profileName === 'default' ? resolveCodexHome('default') : profilePath(profileName);
  if (profileName !== 'default' && !fs.existsSync(target))
    throw new ScriptExitError(1, `Profile '${profileName}' does not exist at ${target}`);
  const bin = getRegisteredEnvText('KYBERION_CODEX_CLI_BIN')?.trim() || 'codex';
  const args = action === 'login' ? ['login', ...extraArgs] : extraArgs;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: target,
    ...(profileName !== 'default' ? { KYBERION_CODEX_PROFILE: profileName } : {}),
  };
  return new Promise<number>((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (error) => {
      console.error(`Failed to launch codex: ${error.message}`);
      resolve(1);
    });
  });
}

export async function main(args: string[] = [], print: Print = console.log): Promise<void> {
  switch (args[0] || 'list') {
    case 'list':
    case 'ls':
      print('Codex Profiles:');
      for (const profile of listProfiles())
        print(
          `  ${profile.active ? '*' : ' '} ${profile.name.padEnd(20)} - ${profile.path} [${profile.authenticated ? 'Authenticated' : 'Not authenticated'}]`
        );
      break;
    case 'add':
    case 'create':
      addProfile(args[1], print);
      break;
    case 'delete':
    case 'rm':
      deleteProfile(args[1], print);
      break;
    case 'login':
    case 'auth': {
      const code = await runCodexCommand('login', args[1]);
      if (code !== 0) throw new ScriptExitError(code);
      break;
    }
    case 'run':
    case 'exec': {
      const code = await runCodexCommand('run', args[1], args.slice(2));
      if (code !== 0) throw new ScriptExitError(code);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      print('Usage: pnpm kyberion codex profile <subcommand> [args...]');
      print('  list                    List account profiles');
      print('  add <name>              Create an isolated CODEX_HOME profile');
      print('  login <name>            Authenticate the profile with ChatGPT');
      print('  run <name> [args...]    Run codex with the selected profile');
      print('  delete <name>           Delete an existing profile');
      break;
    default:
      throw new ScriptExitError(
        1,
        `Unknown subcommand: ${args[0]}. Run 'pnpm kyberion codex profile --help' for usage.`
      );
  }
}

export const runCodexProfileController = defineScript({
  name: 'codex:profile',
  flags: [],
  run: async ({ argv, print }) => {
    await main(argv, print);
  },
});
if (
  isDirectScript(import.meta.url, 'codex_profile_controller.ts') ||
  isDirectScript(import.meta.url, 'codex_profile_controller.js')
)
  void runCodexProfileController();

#!/usr/bin/env node
/* eslint-disable no-restricted-imports, no-restricted-syntax -- Host-level user profile manager managing ~/.agy-profiles and interactive child processes outside repository workspace */
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

type Print = (value: unknown) => void;

function getRealHome(): string {
  const envHome = getRegisteredEnvText('HOME')?.trim() || os.homedir();
  const marker = path.join(envHome, '.agy_profile_marker');
  const realHomeFile = path.join(envHome, '.agy_real_home');
  if (fs.existsSync(marker) && fs.existsSync(realHomeFile)) {
    try {
      const recorded = fs.readFileSync(realHomeFile, 'utf8').trim();
      if (recorded) return recorded;
    } catch {
      /* fallback to envHome */
    }
  }
  return envHome;
}

function getBaseProfilesDir(): string {
  return path.join(getRealHome(), '.agy-profiles');
}

function getDefaultGeminiDir(): string {
  return path.join(getRealHome(), '.gemini', 'antigravity-cli');
}

export function listProfiles(): {
  name: string;
  path: string;
  authenticated: boolean;
  active: boolean;
}[] {
  const activeProfile =
    getRegisteredEnvText('KYBERION_AGY_PROFILE')?.trim() ||
    getRegisteredEnvText('AGY_PROFILE')?.trim() ||
    'default';
  const defaultDir = getDefaultGeminiDir();
  const defaultAuth = fs.existsSync(path.join(defaultDir, 'antigravity-oauth-token'));

  const results: {
    name: string;
    path: string;
    authenticated: boolean;
    active: boolean;
  }[] = [
    {
      name: 'default',
      path: defaultDir,
      authenticated: defaultAuth,
      active: activeProfile === 'default',
    },
  ];

  const baseDir = getBaseProfilesDir();
  if (fs.existsSync(baseDir)) {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const profName = entry.name;
        const profDir = path.join(baseDir, profName);
        const tokenFile = path.join(
          profDir,
          '.gemini',
          'antigravity-cli',
          'antigravity-oauth-token'
        );
        results.push({
          name: profName,
          path: profDir,
          authenticated: fs.existsSync(tokenFile),
          active: activeProfile === profName,
        });
      }
    }
  }

  return results;
}

export function addProfile(name: string, print: Print = console.log): string {
  if (!name) {
    throw new ScriptExitError(1, 'Profile name is required. Usage: agy profile add <name>');
  }
  if (name === 'default') {
    throw new ScriptExitError(1, "'default' is reserved for the primary profile.");
  }
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new ScriptExitError(
      1,
      'Profile name must only contain alphanumeric characters, hyphens, and underscores.'
    );
  }

  const realHome = getRealHome();
  const baseDir = getBaseProfilesDir();
  const profDir = path.resolve(baseDir, name);

  if (!profDir.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new ScriptExitError(1, 'Invalid profile path (path traversal detected).');
  }

  if (fs.existsSync(profDir)) {
    throw new ScriptExitError(1, `Profile '${name}' already exists at ${profDir}`);
  }

  fs.mkdirSync(profDir, { recursive: true });
  fs.writeFileSync(path.join(profDir, '.agy_profile_marker'), 'marker\n', 'utf8');
  fs.writeFileSync(path.join(profDir, '.agy_real_home'), `${realHome}\n`, 'utf8');

  // Link or inherit developer dotfiles from real home
  const dotfiles = [
    '.ssh',
    '.gitconfig',
    '.config',
    '.local',
    '.zshrc',
    '.bashrc',
    '.profile',
    '.npmrc',
    '.docker',
  ];
  for (const item of dotfiles) {
    const src = path.join(realHome, item);
    const dest = path.join(profDir, item);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          // On Windows, use 'junction' for directories to avoid requiring elevated privileges
          const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
          fs.symlinkSync(src, dest, symlinkType);
        } else {
          fs.symlinkSync(src, dest, 'file');
        }
      } catch {
        /* best-effort symlink/junction */
      }
    }
  }

  // Prepare .gemini/antigravity-cli directory
  const profGeminiDir = path.join(profDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(profGeminiDir, { recursive: true });

  const defaultGemini = getDefaultGeminiDir();
  const sharedDirs = ['bin', 'builtin', 'updater'];
  for (const dir of sharedDirs) {
    const src = path.join(defaultGemini, dir);
    const dest = path.join(profGeminiDir, dir);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
        fs.symlinkSync(src, dest, symlinkType);
      } catch {
        /* best-effort symlink/junction */
      }
    }
  }

  // Copy settings.json if exists
  const defaultSettings = path.join(defaultGemini, 'settings.json');
  if (fs.existsSync(defaultSettings)) {
    try {
      fs.copyFileSync(defaultSettings, path.join(profGeminiDir, 'settings.json'));
    } catch {
      /* best-effort settings copy */
    }
  }

  print(`Profile '${name}' created successfully at: ${profDir}`);
  print(`To authenticate with Google for this profile:`);
  print(`  pnpm kyberion agy profile login ${name}`);
  return profDir;
}

export function deleteProfile(name: string, print: Print = console.log): void {
  if (!name) throw new ScriptExitError(1, 'Profile name required.');
  if (name === 'default') throw new ScriptExitError(1, "Cannot delete 'default' profile.");
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new ScriptExitError(1, 'Invalid profile name.');
  }

  const baseDir = getBaseProfilesDir();
  const profDir = path.resolve(baseDir, name);

  if (!profDir.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new ScriptExitError(1, 'Invalid profile path.');
  }

  const realHome = getRealHome();
  if (profDir === realHome || profDir === baseDir) {
    throw new ScriptExitError(1, 'Refusing to delete primary or base profile directory.');
  }

  if (!fs.existsSync(profDir)) {
    throw new ScriptExitError(1, `Profile '${name}' not found at ${profDir}`);
  }

  fs.rmSync(profDir, { recursive: true, force: true });
  print(`Profile '${name}' deleted.`);
}

export function setupHostIntegrations(print: Print = console.log): void {
  const realHome = getRealHome();
  const localBin = path.join(realHome, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });

  const agyProfileScript = path.join(localBin, 'agy-profile');
  const agypScript = path.join(localBin, 'agyp');

  const profileScriptContent = `#!/usr/bin/env bash
# Antigravity CLI Profile Helper (Generated by Kyberion)
exec pnpm --dir "${pathResolver.rootDir()}" kyberion agy profile "$@"
`;

  const agypScriptContent = `#!/usr/bin/env bash
# agyp shortcut (Generated by Kyberion)
if [ -z "$1" ]; then
  exec pnpm --dir "${pathResolver.rootDir()}" kyberion agy profile list
fi
PROFILE="$1"
shift
exec pnpm --dir "${pathResolver.rootDir()}" kyberion agy profile run "$PROFILE" "$@"
`;

  fs.writeFileSync(agyProfileScript, profileScriptContent, { mode: 0o755 });
  fs.writeFileSync(agypScript, agypScriptContent, { mode: 0o755 });
  print(`Installed CLI scripts in ${localBin}:`);
  print(`  - ${agyProfileScript}`);
  print(`  - ${agypScript}`);

  // Windows batch scripts (.cmd) for native Command Prompt & PowerShell execution
  const agyProfileCmd = path.join(localBin, 'agy-profile.cmd');
  const agypCmd = path.join(localBin, 'agyp.cmd');
  const profileCmdContent = `@echo off\r\npnpm --dir "${pathResolver.rootDir()}" kyberion agy profile %*\r\n`;
  const agypCmdContent = `@echo off\r\nif "%~1"=="" (\r\n  pnpm --dir "${pathResolver.rootDir()}" kyberion agy profile list\r\n  exit /b %errorlevel%\r\n)\r\nset "PROF=%~1"\r\nshift\r\npnpm --dir "${pathResolver.rootDir()}" kyberion agy profile run "%PROF%" %*\r\n`;
  fs.writeFileSync(agyProfileCmd, profileCmdContent, 'utf8');
  fs.writeFileSync(agypCmd, agypCmdContent, 'utf8');
  print(`  - ${agyProfileCmd} (Windows batch)`);
  print(`  - ${agypCmd} (Windows batch)`);

  const posixShellSnippet = `
# --- Antigravity CLI Multi-Account Integration ---
agy() {
  if [[ "$1" == "--profile" && -n "$2" ]]; then
    local _profile="$2"
    shift 2
    agy-profile run "$_profile" "$@"
  elif [[ -n "$AGY_PROFILE" && "$AGY_PROFILE" != "default" ]]; then
    agy-profile run "$AGY_PROFILE" "$@"
  else
    command agy "$@"
  fi
}

agy-use() {
  if [[ -z "$1" ]]; then
    agy-profile list
    return 0
  fi
  if [[ "$1" == "default" ]]; then
    unset AGY_PROFILE
    echo "Switched to default profile"
  else
    export AGY_PROFILE="$1"
    echo "Switched to profile: $1 (for current shell session)"
  fi
}
`;

  // Support both zsh (.zshrc) and bash (.bashrc, .bash_profile)
  const posixConfigs = ['.zshrc', '.bashrc', '.bash_profile'];
  for (const configFile of posixConfigs) {
    const configPath = path.join(realHome, configFile);
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      if (!content.includes('Antigravity CLI Multi-Account Integration')) {
        fs.appendFileSync(configPath, posixShellSnippet, 'utf8');
        print(`Added shell wrapper functions (agy, agy-use) to ${configPath}`);
      } else {
        print(`Shell wrapper functions already present in ${configPath}`);
      }
    }
  }

  // Windows PowerShell Profile support (e.g. Documents/PowerShell/Microsoft.PowerShell_profile.ps1)
  const psProfileDirs = [
    path.join(realHome, 'Documents', 'PowerShell'),
    path.join(realHome, 'Documents', 'WindowsPowerShell'),
  ];
  const psSnippet = `
# --- Antigravity CLI Multi-Account Integration ---
function agy {
    if ($args[0] -eq "--profile" -and $args[1]) {
        $profileName = $args[1]
        $remaining = $args[2..($args.Length - 1)]
        agy-profile run $profileName $remaining
    } elseif ($env:AGY_PROFILE -and $env:AGY_PROFILE -ne "default") {
        agy-profile run $env:AGY_PROFILE $args
    } else {
        & (Get-Command agy.cmd, agy.ps1, agy.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1) @args
    }
}

function agy-use {
    param([string]$profileName)
    if (-not $profileName) {
        agy-profile list
        return
    }
    if ($profileName -eq "default") {
        Remove-Item Env:AGY_PROFILE -ErrorAction SilentlyContinue
        Write-Host "Switched to default profile"
    } else {
        $env:AGY_PROFILE = $profileName
        Write-Host "Switched to profile: $profileName (for current shell session)"
    }
}
`;
  for (const psDir of psProfileDirs) {
    if (fs.existsSync(psDir)) {
      const psProfilePath = path.join(psDir, 'Microsoft.PowerShell_profile.ps1');
      if (fs.existsSync(psProfilePath)) {
        const content = fs.readFileSync(psProfilePath, 'utf8');
        if (!content.includes('Antigravity CLI Multi-Account Integration')) {
          fs.appendFileSync(psProfilePath, psSnippet, 'utf8');
          print(`Added PowerShell wrapper functions (agy, agy-use) to ${psProfilePath}`);
        } else {
          print(`PowerShell wrapper functions already present in ${psProfilePath}`);
        }
      }
    }
  }
}

export async function runAgyCommand(
  action: 'login' | 'run',
  profileName: string,
  extraArgs: string[] = []
): Promise<number> {
  if (!profileName) {
    throw new ScriptExitError(1, `Profile name required for ${action}.`);
  }

  let envHome = getRealHome();
  if (profileName !== 'default') {
    if (!/^[a-zA-Z0-9_-]+$/u.test(profileName)) {
      throw new ScriptExitError(1, 'Invalid profile name.');
    }
    const baseDir = getBaseProfilesDir();
    const candidate = path.resolve(baseDir, profileName);
    if (!candidate.startsWith(path.resolve(baseDir) + path.sep) || !fs.existsSync(candidate)) {
      throw new ScriptExitError(1, `Profile '${profileName}' does not exist at ${candidate}`);
    }
    envHome = candidate;
  }

  const agyBin =
    getRegisteredEnvText('KYBERION_AGY_CLI_BIN')?.trim() ||
    getRegisteredEnvText('KYBERION_ANTIGRAVITY_CLI_BIN')?.trim() ||
    'agy';

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: envHome,
    ...(process.platform === 'win32' ? { USERPROFILE: envHome } : {}),
    ...(profileName !== 'default' ? { AGY_PROFILE: profileName } : {}),
  };

  return new Promise<number>((resolve) => {
    const child = spawn(agyBin, extraArgs, {
      stdio: 'inherit',
      env: childEnv,
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`Failed to launch agy: ${err.message}`);
      resolve(1);
    });
  });
}

export async function main(args: string[] = [], print: Print = console.log): Promise<void> {
  const sub = args[0] || 'list';

  switch (sub) {
    case 'list':
    case 'ls': {
      const profiles = listProfiles();
      print('Antigravity Profiles:');
      for (const p of profiles) {
        const marker = p.active ? '*' : ' ';
        const auth = p.authenticated ? 'Authenticated' : 'Not authenticated';
        const label = p.active ? `${p.name} (active)` : p.name;
        print(`  ${marker} ${label.padEnd(20)} - ${p.path} [${auth}]`);
      }
      break;
    }
    case 'add':
    case 'create': {
      addProfile(args[1], print);
      break;
    }
    case 'delete':
    case 'rm': {
      deleteProfile(args[1], print);
      break;
    }
    case 'login':
    case 'auth': {
      const code = await runAgyCommand('login', args[1], []);
      if (code !== 0) throw new ScriptExitError(code);
      break;
    }
    case 'run':
    case 'exec': {
      const code = await runAgyCommand('run', args[1], args.slice(2));
      if (code !== 0) throw new ScriptExitError(code);
      break;
    }
    case 'setup-host': {
      setupHostIntegrations(print);
      break;
    }
    case 'help':
    case '--help':
    case '-h': {
      print('Usage: pnpm kyberion agy profile <subcommand> [args...]');
      print('');
      print('Subcommands:');
      print('  list                    List all available account profiles');
      print('  add <name>              Create a new account profile');
      print('  login <name>            Authenticate the profile via Google OAuth');
      print('  run <name> [args...]    Run agy with the specified profile');
      print('  delete <name>           Delete an existing profile');
      print('  setup-host              Install local CLI scripts & shell functions to host');
      break;
    }
    default:
      throw new ScriptExitError(
        1,
        `Unknown subcommand: ${sub}. Run 'pnpm kyberion agy profile --help' for usage.`
      );
  }
}

export const runAgyProfileController = defineScript({
  name: 'agy:profile',
  flags: [],
  run: async ({ argv, print }) => {
    await main(argv, print);
  },
});

if (
  isDirectScript(import.meta.url, 'agy_profile_controller.ts') ||
  isDirectScript(import.meta.url, 'agy_profile_controller.js')
) {
  void runAgyProfileController();
}

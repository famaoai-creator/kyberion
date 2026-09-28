import * as os from 'node:os';
import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';

export const CODEX_PROFILE_ENV = 'KYBERION_CODEX_PROFILE';
export const CODEX_PROFILE_HOME_ENV = 'CODEX_HOME';
const PROFILE_NAME = /^[a-zA-Z0-9_-]+$/u;

export function resolveCodexProfileName(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const value = getRegisteredEnvText(CODEX_PROFILE_ENV, { env })?.trim();
  return value || undefined;
}

export function resolveCodexHome(
  profile?: string,
  env: Record<string, string | undefined> = process.env
): string {
  const home = getRegisteredEnvText('HOME', { env })?.trim() || os.homedir();
  const selected = profile?.trim() || resolveCodexProfileName(env);
  if (!selected || selected === 'default') {
    return (
      getRegisteredEnvText(CODEX_PROFILE_HOME_ENV, { env })?.trim() || path.join(home, '.codex')
    );
  }
  if (!PROFILE_NAME.test(selected)) {
    throw new Error(
      '[codex-profile] profile name must only contain alphanumeric characters, hyphens, and underscores.'
    );
  }
  return path.join(home, '.codex-profiles', selected);
}

export function assertValidCodexProfileName(name: string): void {
  if (!name || name === 'default' || !PROFILE_NAME.test(name)) {
    throw new Error(
      'Codex profile name must be a non-default alphanumeric name using hyphens or underscores.'
    );
  }
}

export function codexProfileRoot(env: Record<string, string | undefined> = process.env): string {
  const home = getRegisteredEnvText('HOME', { env })?.trim() || os.homedir();
  return path.join(home, '.codex-profiles');
}

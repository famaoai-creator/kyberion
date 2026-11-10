/**
 * Dotenv persistence helpers for non-secret operator settings in `.env.local`.
 * Shared by CLI selection scripts and the concierge settings API.
 */
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeLstat, safeWriteFile } from '../secure-io.js';
import { readTextFile } from './text.js';

export function defaultEnvLocalPath(): string {
  return pathResolver.rootResolve('.env.local');
}

export function readReasoningSelectionTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

/** Pure upsert of one `KEY=value` line in dotenv-style content. */
export function upsertEnvVarLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^\\s*${key}=.*$`, 'gm');
  if (matcher.test(content)) {
    return content.replace(matcher, line);
  }
  let next = content;
  if (next.length > 0 && !next.endsWith('\n')) next += '\n';
  return `${next}${line}\n`;
}

/** Read one persisted dotenv value without loading secrets into process.env. */
export function readPersistedEnvValue(
  key: string,
  envLocalPath: string = defaultEnvLocalPath()
): string | null {
  if (!safeExistsSync(envLocalPath)) return null;
  const content = readReasoningSelectionTextFile(envLocalPath);
  const match = new RegExp(`^\\s*${key}=(.*)$`, 'm').exec(content);
  const value = match?.[1]?.trim();
  return value || null;
}

/**
 * Persist one non-secret operator preference in `.env.local`.
 *
 * Only the one `KEY=` line changes. `.env.local` usually also holds secrets,
 * so the write is atomic (safeWriteFile: temp + rename) and keeps the
 * existing file mode; a new file is created owner-only (0600) rather than
 * world-readable.
 */
export function persistEnvValue(
  key: string,
  value: string,
  envLocalPath: string = defaultEnvLocalPath()
): string {
  let content = '';
  let mode = 0o600;
  if (safeExistsSync(envLocalPath)) {
    content = readReasoningSelectionTextFile(envLocalPath);
    mode = safeLstat(envLocalPath).mode & 0o777;
  }
  safeWriteFile(envLocalPath, upsertEnvVarLine(content, key, value), { mode });
  return envLocalPath;
}

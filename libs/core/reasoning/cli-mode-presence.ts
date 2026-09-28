/**
 * CLI reasoning modes whose availability is already answered by provider
 * discovery. Chain construction must not spawn again when that answer is
 * "not installed".
 */
const CLI_DISCOVERY_MODES: ReadonlySet<string> = new Set([
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'agy-cli',
  'grok-cli',
  'copilot',
  'cursor-cli',
  'opencode-cli',
  'devin-cli',
]);

export function isCliDiscoveryMode(mode: string): boolean {
  return CLI_DISCOVERY_MODES.has(mode);
}

export function cliModeAbsentFromDiscovery(
  mode: string,
  providerId: string | undefined,
  providers: readonly { provider: string; installed: boolean }[]
): boolean {
  if (!isCliDiscoveryMode(mode) || !providerId) return false;
  const found = providers.find((entry) => entry.provider === providerId);
  return found !== undefined && found.installed === false;
}

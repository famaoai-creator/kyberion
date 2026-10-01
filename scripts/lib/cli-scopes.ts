/**
 * CU-08 / CU-09: registry-driven argument rewriting for the kyberion router.
 *
 * - `deprecated_command_aliases`: a renamed command (`customer create`) keeps
 *   working; the router warns once and dispatches the replacement.
 * - command `scopes`: `doctor --scope <id>` and `setup <area>` delegate to an
 *   existing registered command (`service preflight`, `env bootstrap`, ...).
 *   The bare command keeps its own behavior.
 *
 * Everything here is pure: it maps arguments to arguments from `cli-commands.json`.
 */
import { t, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale';
import type { CliCommand, CliDeprecatedCommandAlias, CliManifest } from '../check_cli_manifest.js';

export const SCOPE_FLAG = '--scope';

export type ScopedRoute =
  | { kind: 'none' }
  | { kind: 'route'; scope: string; args: string[] }
  | { kind: 'unknown'; scope: string };

export function findDeprecatedCommandAlias(
  command: string,
  manifest: CliManifest
): CliDeprecatedCommandAlias | undefined {
  return (manifest.deprecated_command_aliases ?? []).find((alias) => alias.command === command);
}

/** Replace the typed (deprecated) command tokens with the replacement's tokens. */
export function rewriteDeprecatedCommand(
  alias: CliDeprecatedCommandAlias,
  args: readonly string[]
): string[] {
  return [...alias.replaced_by.split(' '), ...args.slice(alias.command.split(' ').length)];
}

/** Pull `--scope <id>` / `--scope=<id>` out of the arguments after the command. */
function extractScopeFlag(rest: readonly string[]): { scope?: string; remaining: string[] } {
  const remaining: string[] = [];
  let scope: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === SCOPE_FLAG) {
      scope = rest[index + 1] && !rest[index + 1]!.startsWith('-') ? rest[index + 1] : '';
      if (scope) index += 1;
      continue;
    }
    if (arg.startsWith(`${SCOPE_FLAG}=`)) {
      scope = arg.slice(SCOPE_FLAG.length + 1);
      continue;
    }
    remaining.push(arg);
  }
  return { scope, remaining };
}

/**
 * Resolve a scope for a command that declares `scopes`. `args` are the full
 * router arguments (command tokens first).
 */
export function routeScopedCommand(command: CliCommand, args: readonly string[]): ScopedRoute {
  if (!command.scopes || command.scopes.length === 0) return { kind: 'none' };
  const rest = args.slice(command.command.split(' ').length);
  let scopeId: string | undefined;
  let remaining: string[];
  if (command.scope_selector === 'flag') {
    ({ scope: scopeId, remaining } = extractScopeFlag(rest));
  } else {
    const first = rest[0];
    if (first === undefined || first.startsWith('-')) return { kind: 'none' };
    scopeId = first;
    remaining = rest.slice(1);
  }
  if (scopeId === undefined) return { kind: 'none' };
  const scope = command.scopes.find((candidate) => candidate.id === scopeId);
  if (!scope) return { kind: 'unknown', scope: scopeId };
  return { kind: 'route', scope: scope.id, args: [...scope.routes_to, ...remaining] };
}

/** `--scope env|service|...` or `<onboarding|context|...>`, for help lines. */
export function formatScopeUsage(command: CliCommand): string | undefined {
  if (!command.scopes || command.scopes.length === 0) return undefined;
  const ids = command.scopes.map((scope) => scope.id).join('|');
  return command.scope_selector === 'flag' ? `${SCOPE_FLAG} ${ids}` : `<${ids}>`;
}

/** Per-scope table: what each scope checks/sets up and which command it delegates to. */
export function formatScopeHelp(command: CliCommand, locale?: SupportedLocale): string {
  const usage = formatScopeUsage(command) ?? '';
  const lines = [
    t('cli:cli_scope_help_usage', { usage: `pnpm kyberion ${command.command} ${usage}` }, locale),
    '',
  ];
  for (const scope of command.scopes ?? []) {
    const summary = t(`cli:${scope.description}` as VocabularyKey, undefined, locale);
    lines.push(`  ${scope.id.padEnd(14)} ${summary}`);
    lines.push(
      `  ${''.padEnd(14)} ${t('cli:cli_scope_help_delegates', { command: `pnpm kyberion ${scope.routes_to.join(' ')}` }, locale)}`
    );
  }
  return lines.join('\n');
}

/** Operator-facing message for an unknown scope / area. */
export function formatUnknownScope(
  command: CliCommand,
  scope: string,
  locale?: SupportedLocale
): string {
  return [
    t(
      'cli:cli_scope_unknown',
      {
        command: command.command,
        scope: scope || '<missing>',
        scopes: (command.scopes ?? []).map((candidate) => candidate.id).join(', '),
      },
      locale
    ),
    '',
    formatScopeHelp(command, locale),
  ].join('\n');
}

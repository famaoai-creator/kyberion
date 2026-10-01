/**
 * CU-03 / CU-04: the one renderer behind `kyberion --help`, `kyberion help`,
 * and the router's unknown-command hint. Everything is derived from the
 * governed registry (`cli-commands.json`): each entry's `description` /
 * `caution` vocabulary keys (en + ja) and its `group`.
 */
import { t, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale';
import {
  CLI_COMMAND_GROUPS,
  loadCliManifest,
  type CliCommand,
  type CliCommandGroup,
  type CliManifest,
  type CliScriptCommand,
} from '../check_cli_manifest.js';
import { formatScopeUsage } from './cli-scopes.js';

export interface CliHelpOptions {
  /** Include audience=dev commands (hidden by default). */
  all?: boolean;
  locale?: SupportedLocale;
}

interface HelpRow {
  label: string;
  group: CliCommandGroup;
  summary: string;
  caution?: string;
  /** CU-09: `--scope a|b` / `<a|b>` for commands that route scopes. */
  scopes?: string;
}

const LABEL_WIDTH = 30;

/** The name an operator types: `<noun> default` script entries route as `<noun>`. */
export function routedCommandName(command: string): string {
  return command.endsWith(' default') ? command.slice(0, -' default'.length) : command;
}

function render(key: string | undefined, locale?: SupportedLocale): string | undefined {
  return key ? t(key as VocabularyKey, undefined, locale) : undefined;
}

function groupOf(command: CliCommand | CliScriptCommand): CliCommandGroup {
  if (command.group) return command.group;
  return command.audience === 'dev' ? 'dev' : 'operate';
}

function helpRows(manifest: CliManifest, locale?: SupportedLocale): HelpRow[] {
  const entries: Array<CliCommand | CliScriptCommand> = [
    ...manifest.commands,
    // A `same_target_as` script entry is the governed command under its
    // package-script name; list it once. The `kyberion` script is the router itself.
    ...(manifest.script_commands ?? []).filter(
      (command) => !command.same_target_as && command.script !== 'kyberion'
    ),
  ];
  return entries
    .map((command) => ({
      label: command.command === '' ? '<home>' : routedCommandName(command.command),
      group: groupOf(command),
      summary: render(command.description, locale) ?? `${command.noun} ${command.verb}`,
      caution: render(command.caution, locale),
      scopes: 'entry' in command ? formatScopeUsage(command) : undefined,
    }))
    .sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
}

/** Summary (+ caution) lines for one registry entry, used by guarded `--help`. */
export function describeRegisteredCommand(
  command: CliCommand | CliScriptCommand,
  locale?: SupportedLocale
): string[] {
  const summary = render(command.description, locale) ?? `${command.noun} ${command.verb}`;
  const caution = render(command.caution, locale);
  return caution ? [summary, caution] : [summary];
}

export function formatCliManifestHelp(
  manifest: CliManifest = loadCliManifest(),
  options: CliHelpOptions = {}
): string {
  const { locale } = options;
  const rows = helpRows(manifest, locale);
  const lines = [
    t('cli:cli_manifest_help_title', undefined, locale),
    t('cli:cli_help_usage', undefined, locale),
  ];
  for (const group of CLI_COMMAND_GROUPS) {
    if (group === 'dev' && !options.all) continue;
    const groupRows = rows.filter((row) => row.group === group);
    if (groupRows.length === 0) continue;
    lines.push('', t(`cli:cli_manifest_help_group_${group}` as VocabularyKey, undefined, locale));
    for (const row of groupRows) {
      lines.push(`  ${row.label.padEnd(LABEL_WIDTH)} ${row.summary}`);
      if (row.caution) lines.push(`  ${''.padEnd(LABEL_WIDTH)} ${row.caution}`);
      if (row.scopes) {
        lines.push(
          `  ${''.padEnd(LABEL_WIDTH)} ${t('cli:cli_manifest_help_scopes', { usage: `${row.label} ${row.scopes}` }, locale)}`
        );
      }
    }
  }
  lines.push('', t('cli:cli_manifest_help_footer', undefined, locale));
  lines.push(t('cli:cli_manifest_help_footer_detail', undefined, locale));
  const hidden = rows.filter((row) => row.group === 'dev').length;
  if (!options.all && hidden > 0) {
    lines.push(t('cli:cli_manifest_help_footer_all', { count: hidden }, locale));
  }
  return lines.join('\n');
}

/** Optimal-string-alignment edit distance (a transposition such as aks→ask costs 1). */
export function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const row = table[i] as number[];
      const above = table[i - 1] as number[];
      row[j] = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        row[j] = Math.min(row[j] as number, ((table[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (table[left.length] as number[])[right.length] as number;
}

/** CU-04: closest registered command names for a mistyped command. */
export function suggestCommands(
  input: string,
  manifest: CliManifest = loadCliManifest(),
  limit = 3
): string[] {
  const needle = input.trim().toLowerCase().replace(/\s+/gu, ' ');
  if (!needle) return [];
  const first = needle.split(' ')[0] as string;
  const names = new Set(
    [
      ...manifest.commands,
      ...(manifest.script_commands ?? []).filter((command) => command.script !== 'kyberion'),
    ]
      .map((command) => routedCommandName(command.command))
      .filter(Boolean)
  );
  const allowance = (text: string): number => Math.max(1, Math.floor(text.length / 3));
  return [...names]
    .map((name) => {
      const head = name.split(' ')[0] as string;
      // Score = edits beyond the allowance; <= 0 is close enough to suggest.
      // Compare the full input ("pr crate") and its first word ("aks <payload>").
      const distance = Math.min(
        editDistance(needle, name) - allowance(needle),
        editDistance(first, head) - allowance(first),
        editDistance(first, name) - allowance(first)
      );
      return { name, distance };
    })
    .filter((candidate) => candidate.distance <= 0)
    .sort((left, right) =>
      left.distance !== right.distance
        ? left.distance - right.distance
        : left.name < right.name
          ? -1
          : left.name > right.name
            ? 1
            : 0
    )
    .slice(0, limit)
    .map((candidate) => candidate.name);
}

/** CU-04: operator-facing message for an unknown command. */
export function formatUnknownCommand(
  command: string,
  manifest: CliManifest = loadCliManifest(),
  locale?: SupportedLocale
): string {
  const lines = [t('cli:cli_unknown_command_hint', { command }, locale)];
  const suggestions = suggestCommands(command, manifest);
  if (suggestions.length > 0) {
    lines.push(
      t(
        'cli:cli_unknown_command_suggest',
        { suggestions: suggestions.map((name) => `kyberion ${name}`).join(', ') },
        locale
      )
    );
  }
  lines.push(t('cli:cli_unknown_command_help', undefined, locale));
  return lines.join('\n');
}

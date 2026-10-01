/**
 * generate_cli_reference.ts — CU-11: docs/CLI_REFERENCE.md generated from the
 * governed command manifest (cli-commands.json) and the `cli` vocabulary
 * namespace, so the command reference cannot drift from the router.
 *
 * Usage:
 *   pnpm generate:cli-reference           — write docs/CLI_REFERENCE.md
 *   pnpm generate:cli-reference --check   — fail if the page is stale
 */

import { pathResolver } from '@agent/core/path-resolver';
import { resolveVocabularyEntry } from '@agent/core/knowledge/vocabulary-catalog';
import { format as prettierFormat } from 'prettier';
import { defineGenerator, isDirectScript } from './lib/harness.js';
import {
  CLI_COMMAND_GROUPS,
  loadCliManifest,
  type CliCommandGroup,
  type CliManifest,
} from './check_cli_manifest.js';

const OUTPUT_PATH = pathResolver.rootResolve('docs/CLI_REFERENCE.md');

export interface CliReferenceRow {
  command: string;
  script?: string;
  summary: string;
  audience: 'user' | 'operator' | 'dev';
  group: CliCommandGroup;
}

function describe(key: string | undefined): string {
  if (!key) return '';
  const resolved = resolveVocabularyEntry(`cli:${key}`);
  return (resolved?.entry.en ?? key).replace(/\|/gu, '\\|');
}

/** `x default` is invoked as plain `x`; the home command is the bare `kyberion`. */
function invocation(command: string): string {
  const shown = command.replace(/ default$/u, '');
  return shown ? `pnpm kyberion ${shown}` : 'pnpm kyberion';
}

export function buildCliReferenceRows(manifest: CliManifest): CliReferenceRow[] {
  const rows = new Map<string, CliReferenceRow>();
  const byId = new Map<string, CliReferenceRow>();
  for (const command of manifest.commands) {
    const row: CliReferenceRow = {
      command: invocation(command.command),
      summary: describe(command.description),
      audience: command.audience,
      group: command.group ?? 'operate',
    };
    rows.set(row.command, row);
    byId.set(command.id, row);
  }
  for (const script of manifest.script_commands ?? []) {
    const target = script.same_target_as ? byId.get(script.same_target_as) : undefined;
    if (target) {
      if (script.script) target.script = script.script;
      continue;
    }
    const row: CliReferenceRow = {
      command: invocation(script.command),
      script: script.script,
      summary: describe(script.description),
      audience: script.audience,
      group: script.group ?? 'operate',
    };
    const existing = rows.get(row.command);
    if (existing) {
      if (script.script) existing.script = script.script;
      continue;
    }
    rows.set(row.command, row);
  }
  return [...rows.values()];
}

/** Scripts whose bare `pnpm <name>` is shadowed by a pnpm built-in. */
const PNPM_SHADOWED_SCRIPTS: ReadonlySet<string> = new Set(['doctor']);

function scriptInvocation(script: string): string {
  return PNPM_SHADOWED_SCRIPTS.has(script) ? `pnpm run ${script}` : `pnpm ${script}`;
}

function table(headers: string[], body: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
}

const GROUP_TITLES: Record<CliCommandGroup, string> = {
  start: 'Start',
  inspect: 'Inspect',
  operate: 'Operate',
  dev: 'Develop',
};

function commandTable(rows: CliReferenceRow[], withScript: boolean): string {
  const sorted = [...rows].sort((a, b) => a.command.localeCompare(b.command));
  return table(
    withScript ? ['Command', 'pnpm script', 'What it does'] : ['Command', 'What it does'],
    sorted.map((row) =>
      withScript
        ? [
            `\`${row.command}\``,
            row.script ? `\`${scriptInvocation(row.script)}\`` : '',
            row.summary,
          ]
        : [`\`${row.command}\``, row.summary]
    )
  );
}

export function renderCliReference(manifest: CliManifest): string {
  const rows = buildCliReferenceRows(manifest);
  const sections: string[] = [
    '# CLI Reference',
    [
      '<!-- GENERATED FILE — DO NOT EDIT BY HAND.',
      '     Source: knowledge/product/governance/cli-commands.json + the `cli` namespace of',
      '     knowledge/product/orchestration/user-facing-vocabulary.json.',
      '     Regenerate: pnpm generate:cli-reference   Check: pnpm generate:cli-reference --check -->',
    ].join('\n'),
    'Every governed `kyberion` command and `pnpm` script, generated from the command manifest. Run `pnpm kyberion --help` for the same list in your terminal, and `pnpm kyberion <command> --help` for one command. Task-oriented walk-throughs of the everyday commands are in the [Commands Guide](./user/COMMANDS_GUIDE.md); first-time setup is in [QUICKSTART](./QUICKSTART.md).',
    '`pnpm kyberion <command>` and the matching `pnpm <script>` run the same target; use whichever you prefer.',
    '## Everyday commands (user)',
  ];
  const user = rows.filter((row) => row.audience === 'user');
  for (const group of CLI_COMMAND_GROUPS.filter((g) => g !== 'dev')) {
    const groupRows = user.filter((row) => row.group === group);
    if (groupRows.length === 0) continue;
    sections.push(`### ${GROUP_TITLES[group]}`, commandTable(groupRows, true));
  }
  sections.push('## Operator commands');
  const operator = rows.filter((row) => row.audience === 'operator');
  for (const group of CLI_COMMAND_GROUPS.filter((g) => g !== 'dev')) {
    const groupRows = operator.filter((row) => row.group === group);
    if (groupRows.length === 0) continue;
    sections.push(`### ${GROUP_TITLES[group]}`, commandTable(groupRows, true));
  }
  sections.push(
    '## Developer commands',
    'Repository build, test, generator and gate scripts for contributors.',
    commandTable(
      rows.filter((row) => row.audience === 'dev'),
      true
    )
  );

  const scoped = manifest.commands.filter((command) => command.scopes?.length);
  if (scoped.length > 0) {
    sections.push('## Scopes and areas');
    for (const command of scoped) {
      const flag = command.scope_selector === 'flag';
      const base = invocation(command.command);
      sections.push(
        `### \`${base}\` ${flag ? '`--scope <id>`' : '`<area>`'}`,
        table(
          [flag ? 'Scope' : 'Area', 'Runs', 'What it does'],
          (command.scopes ?? []).map((scope) => [
            `\`${scope.id}\``,
            `\`pnpm kyberion ${scope.routes_to.join(' ')}\``,
            describe(scope.description),
          ])
        )
      );
    }
  }

  const scriptAliases = manifest.deprecated_script_aliases ?? [];
  const commandAliases = manifest.deprecated_command_aliases ?? [];
  sections.push(
    '## Deprecated aliases',
    'Renamed entries keep working and print a one-line deprecation warning. Prefer the replacement.'
  );
  if (scriptAliases.length > 0) {
    sections.push(
      '### pnpm scripts',
      table(
        ['Old', 'Use instead'],
        scriptAliases.map((alias) => [`\`pnpm ${alias.script}\``, `\`pnpm ${alias.replaced_by}\``])
      )
    );
  }
  if (commandAliases.length > 0) {
    sections.push(
      '### kyberion commands',
      table(
        ['Old', 'Use instead'],
        commandAliases.map((alias) => [
          `\`pnpm kyberion ${alias.command}\``,
          `\`pnpm kyberion ${alias.replaced_by}\``,
        ])
      )
    );
  }
  return sections.join('\n\n') + '\n';
}

export const main = defineGenerator({
  id: 'cli-reference',
  outputs: [OUTPUT_PATH],
  async render() {
    const content = await prettierFormat(renderCliReference(loadCliManifest()), {
      parser: 'markdown',
      singleQuote: true,
      printWidth: 100,
    });
    return [{ path: OUTPUT_PATH, content }];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_cli_reference.ts') ||
  isDirectScript(import.meta.url, 'generate_cli_reference.js')
)
  void main();

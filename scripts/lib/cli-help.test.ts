import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { t, type VocabularyKey } from '@agent/core/t';
import { loadCliManifest } from '../check_cli_manifest.js';
import {
  editDistance,
  formatCliManifestHelp,
  formatUnknownCommand,
  suggestCommands,
} from './cli-help.js';

const manifest = loadCliManifest();

describe('CU-03 registry help renderer', () => {
  it('gives every registered command an en + ja description in the cli vocabulary namespace', () => {
    const vocabulary = JSON.parse(
      String(
        safeReadFile(
          pathResolver.rootResolve('knowledge/product/orchestration/user-facing-vocabulary.json'),
          { encoding: 'utf8' }
        )
      )
    ) as { domains: Record<string, Record<string, Record<string, string>>> };
    const cli = vocabulary.domains.cli ?? {};
    const missing = [...manifest.commands, ...(manifest.script_commands ?? [])]
      .flatMap((command) => [
        command.description,
        command.caution,
        ...('scopes' in command ? (command.scopes ?? []).map((scope) => scope.description) : []),
      ])
      .filter((key): key is string => Boolean(key))
      .filter((key) => !cli[key]?.en || !cli[key]?.ja);
    expect(missing).toEqual([]);
  });

  it('groups commands by task and hides dev commands unless --all', () => {
    const help = formatCliManifestHelp(manifest, { locale: 'en' });
    const starts = (key: string) => help.indexOf(t(key as VocabularyKey, undefined, 'en'));
    expect(starts('cli:cli_manifest_help_group_start')).toBeGreaterThan(-1);
    expect(starts('cli:cli_manifest_help_group_inspect')).toBeGreaterThan(
      starts('cli:cli_manifest_help_group_start')
    );
    expect(starts('cli:cli_manifest_help_group_operate')).toBeGreaterThan(
      starts('cli:cli_manifest_help_group_inspect')
    );
    expect(help).not.toContain(t('cli:cli_manifest_help_group_dev', undefined, 'en'));
    expect(help).not.toMatch(/^ {2}typecheck /mu);
    expect(help).toContain('Run the onboarding wizard');

    const all = formatCliManifestHelp(manifest, { all: true, locale: 'en' });
    expect(all).toContain(t('cli:cli_manifest_help_group_dev', undefined, 'en'));
    expect(all).toMatch(/^ {2}typecheck /mu);
  });

  it('keeps the pr create caution next to its summary', () => {
    const lines = formatCliManifestHelp(manifest, { locale: 'en' }).split('\n');
    const index = lines.findIndex((line) => line.startsWith('  pr create '));
    expect(index).toBeGreaterThan(-1);
    expect(lines[index + 1]).toContain(t('cli:cli_caution_pr_create', undefined, 'en'));
  });

  it('renders Japanese descriptions from the same registry', () => {
    const help = formatCliManifestHelp(manifest, { locale: 'ja' });
    expect(help).toContain(t('cli:cli_manifest_help_group_start', undefined, 'ja'));
    expect(help).toContain('オンボーディングウィザードを実行');
  });

  it('shows the doctor scopes and setup areas under their commands (CU-09)', () => {
    const lines = formatCliManifestHelp(manifest, { locale: 'en' }).split('\n');
    const doctor = lines.findIndex((line) => line.startsWith('  doctor '));
    expect(lines[doctor + 1]).toContain(
      'Scopes: doctor --scope env|service|voice|meeting|app|setup'
    );
    const setup = lines.findIndex((line) => /^ {2}setup {2,}/u.test(line));
    expect(lines[setup + 1]).toContain('Scopes: setup <onboarding|context|reasoning|');
    const ja = formatCliManifestHelp(manifest, { locale: 'ja' });
    expect(ja).toContain('スコープ: doctor --scope env|');
  });

  it('lists a same-target script alias once (under the governed command)', () => {
    const help = formatCliManifestHelp(manifest, { locale: 'en' });
    expect(help.match(/^ {2}doctor /gmu)).toHaveLength(1);
  });
});

describe('CU-04 unknown command hints', () => {
  it('suggests close registered commands', () => {
    expect(editDistance('aks', 'ask')).toBe(1);
    expect(suggestCommands('doctr', manifest)).toEqual(['doctor']);
    // The closest registered command comes first, however many siblings (`pr shadow-*`) also match.
    expect(suggestCommands('pr crate', manifest)[0]).toBe('pr create');
    expect(suggestCommands('aks hello world', manifest)).toContain('ask');
    expect(suggestCommands('zzzzzzzz', manifest)).toEqual([]);
  });

  it('always points at kyberion --help', () => {
    const message = formatUnknownCommand('doctr', manifest, 'en');
    expect(message).toContain(t('cli:cli_unknown_command_hint', { command: 'doctr' }, 'en'));
    expect(message).toContain('kyberion doctor');
    expect(message).toContain(t('cli:cli_unknown_command_help', undefined, 'en'));
  });
});

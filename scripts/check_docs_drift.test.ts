import { describe, expect, it } from 'vitest';
import type { CliManifest } from './check_cli_manifest.js';
import {
  applyBaseline,
  buildCommandIndex,
  checkCommandInvocations,
  checkComponentMap,
  checkCliReferenceFresh,
  checkPipelineCatalog,
  extractCodeSnippets,
  extractPnpmInvocations,
  findingKey,
} from './check_docs_drift.js';
import { buildCliReferenceRows, renderCliReference } from './generate_cli_reference.js';

const manifest: CliManifest = {
  version: 1,
  entrypoints: [
    { id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: ['', 'doctor'] },
    {
      id: 'operator-cli',
      module: 'scripts/cli.ts',
      commands: ['email', 'email status', 'memory'],
    },
  ],
  commands: [
    {
      id: 'operator-home.default',
      command: '',
      noun: 'home',
      verb: 'default',
      entry: 'operator-home',
      audience: 'user',
      description: 'cli_cmd_operator_home_default',
      group: 'start',
    },
    {
      id: 'operator-home.doctor',
      command: 'doctor',
      noun: 'doctor',
      verb: 'default',
      entry: 'operator-home',
      audience: 'user',
      description: 'cli_cmd_operator_home_default',
      group: 'start',
    },
    {
      id: 'operator-cli.email.status',
      command: 'email status',
      noun: 'email',
      verb: 'status',
      entry: 'operator-cli',
      audience: 'user',
      description: 'cli_cmd_operator_home_default',
      group: 'inspect',
    },
  ],
  script_commands: [
    {
      id: 'script.doctor',
      script: 'doctor',
      command: 'doctor default',
      noun: 'doctor',
      verb: 'default',
      audience: 'operator',
      same_target_as: 'operator-home.doctor',
    },
    {
      id: 'script.mission',
      script: 'mission',
      command: 'mission default',
      noun: 'mission',
      verb: 'default',
      audience: 'operator',
      group: 'operate',
    },
  ],
  deprecated_script_aliases: [{ script: 'onboard', replaced_by: 'onboarding' }],
  deprecated_command_aliases: [{ command: 'chronos', replaced_by: 'scheduler' }],
};
const index = buildCommandIndex(manifest, ['mission', 'doctor', 'onboard', 'onboarding', 'build']);

const check = (markdown: string) => checkCommandInvocations('docs/x.md', markdown, index);

describe('extractCodeSnippets', () => {
  it('keeps fenced command lines, drops shell comments and prose', () => {
    const md =
      'Run pnpm nothing here.\n\n```bash\n# pnpm is great\npnpm build\n```\n\nUse `pnpm mission`.';
    expect(extractCodeSnippets(md).map((s) => s.text)).toEqual(['pnpm build', 'pnpm mission']);
  });
});

describe('extractPnpmInvocations', () => {
  it('reads scripts, run, and kyberion words; skips flags and placeholders', () => {
    expect(extractPnpmInvocations('pnpm run mission --x')).toMatchObject([
      { kind: 'script', name: 'mission', viaRun: true },
    ]);
    expect(extractPnpmInvocations('pnpm kyberion email status --json')[0]?.words).toEqual([
      'email',
      'status',
    ]);
    expect(extractPnpmInvocations('pnpm --filter x build')).toEqual([]);
    expect(extractPnpmInvocations('pnpm <script>')).toEqual([]);
    expect(extractPnpmInvocations('pnpm kyberion approve <id> project-trust')[0]?.words).toEqual([
      'approve',
    ]);
  });
});

describe('checkCommandInvocations', () => {
  it('accepts package scripts, built-ins and registered kyberion commands', () => {
    expect(
      check('`pnpm mission` `pnpm install` `pnpm vitest run` `pnpm kyberion email status`')
    ).toEqual([]);
    expect(check('`pnpm kyberion email draft --x`')).toEqual([]); // `email` is registered
    expect(check('`pnpm kyberion`')).toEqual([]);
  });

  it('rejects unknown scripts and unknown kyberion commands', () => {
    expect(check('`pnpm nope`')[0]).toMatchObject({ severity: 'error', rule: 'command' });
    expect(check('`pnpm kyberion bogus`')[0]).toMatchObject({ severity: 'error' });
  });

  it('warns on deprecated aliases', () => {
    expect(check('`pnpm onboard`')[0]).toMatchObject({ severity: 'warn' });
    expect(check('`pnpm kyberion chronos`')[0]).toMatchObject({ severity: 'warn' });
  });

  it('flags bare `pnpm doctor` as an error but allows `pnpm run doctor` and explanations', () => {
    expect(check('`pnpm doctor`')[0]).toMatchObject({ severity: 'error' });
    expect(check('`pnpm run doctor`')).toEqual([]);
    expect(check('Bare `pnpm doctor` is pnpm built-in.')).toEqual([]);
  });
});

describe('checkPipelineCatalog / checkComponentMap', () => {
  it('reports pipelines missing from the README', () => {
    const findings = checkPipelineCatalog(['a', 'b'], '| `a` | x |');
    expect(findings.map((f) => f.detail)).toEqual(['pipelines/b.json is not listed']);
  });

  it('reports top-level directories missing from the table', () => {
    const table = '| `docs/` | docs |\n| `libs/core/` | core |\n';
    expect(checkComponentMap(['docs', 'libs', 'tools'], table).map((f) => f.detail)).toEqual([
      'top-level directory tools/ is missing from the table',
    ]);
  });
});

describe('cli reference', () => {
  it('merges same-target scripts into the command row and shadows pnpm doctor', () => {
    const rows = buildCliReferenceRows(manifest);
    expect(rows.find((r) => r.command === 'pnpm kyberion doctor')?.script).toBe('doctor');
    expect(rows.some((r) => r.command === 'pnpm kyberion mission')).toBe(true);
    const page = renderCliReference(manifest);
    expect(page).toContain('`pnpm run doctor`');
    expect(page).toContain('| `pnpm onboard` | `pnpm onboarding` |');
  });

  it('detects a stale or missing page', async () => {
    expect((await checkCliReferenceFresh(manifest, null))[0]?.detail).toContain('missing');
    expect((await checkCliReferenceFresh(manifest, 'old'))[0]?.detail).toContain('stale');
  });
});

describe('applyBaseline', () => {
  const finding = {
    rule: 'command' as const,
    severity: 'error' as const,
    file: 'docs/x.md',
    detail: 'pnpm nope',
  };
  it('suppresses baselined findings and fails on stale baseline entries', () => {
    const key = findingKey(finding);
    expect(applyBaseline([finding], { exceptions: [{ key, reason: 'r' }] }).errors).toEqual([]);
    expect(applyBaseline([], { exceptions: [{ key, reason: 'r' }] }).staleBaseline).toEqual([key]);
    expect(applyBaseline([finding], { exceptions: [] }).errors).toHaveLength(1);
  });
});

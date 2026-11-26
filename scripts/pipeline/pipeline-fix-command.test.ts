import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmdirSync,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { ARGS_SUGGESTION_CAVEAT, type RunScope } from '@agent/core/pipeline/run-manifest';
import { pipelineFixBackupTarget, runPipelineFix } from './pipeline-fix-command.js';
import { runPipelineCheck } from './pipeline-execution-part-manifest.js';
import { main as runPipelineMain } from './pipeline-execution-part-results.js';
import { resolvePipelinePresetArgs } from '../run_pipeline.js';

const PROFILES = 'active/shared/runtime/browser/profiles/public/shared';

/** Synthetic ADF (no tenant content): a templated script, a credential script, a profile outside the partition. */
function adfText(profile: string): string {
  return `{
  "pipeline_id": "pipeline-fix-cli",
  "context": { "limit": 12345678901234567890 },
  "options": { "user_data_dir": ${JSON.stringify(profile)} },
  "steps": [
    { "id": "open", "op": "browser:goto", "params": { "url": "https://app.example.test/" } },
    {
      "id": "pick",
      "op": "browser:evaluate",
      "params": { "script": "(() => '{{target}}'.split(' | ')[0])()", "export_as": "first" }
    },
    {
      "id": "token",
      "op": "browser:evaluate",
      "params": { "script": "(() => fetch('/api', { headers: { t: '{{env.PORTAL_TOKEN}}' } }))()" }
    }
  ]
}
`;
}

describe('pnpm pipeline fix', () => {
  let dir = '';
  let rel = '';
  let file = '';
  let profileName = '';
  let cleanup: string[] = [];
  /** Profile partition directories the test may create (removed when they did not exist). */
  const partitionDirs = [
    'active/shared/runtime/browser/profiles/public/shared',
    'active/shared/runtime/browser/profiles/public',
    'active/shared/runtime/browser/profiles',
  ].map((entry) => pathResolver.rootResolve(entry));
  let preexisting: boolean[] = [];
  const scope = (): RunScope => ({ input_path: rel, tier: 'public', source: 'ambient' });
  const run = async (
    options: { write?: boolean; moveProfile?: boolean; beforeWrite?: () => void } = {}
  ) => {
    const printed: string[] = [];
    await runPipelineFix({
      inputPath: rel,
      write: options.write ?? false,
      moveProfile: options.moveProfile ?? false,
      json: false,
      print: (value) => printed.push(String(value)),
      deps: {
        deriveScope: scope,
        now: () => new Date('2026-11-26T01:02:03.000Z'),
        // The real backup lands on the artifact floor (live state); tests keep it in their dir.
        writeBackup: (_scope, sourceText, now) => {
          const backup = path.join(dir, `backup.${now.getTime()}.json`);
          safeWriteFile(backup, sourceText);
          return pathResolver.toRepoRelative(backup);
        },
        ...(options.beforeWrite ? { beforeWrite: options.beforeWrite } : {}),
      },
    });
    return printed;
  };

  beforeEach(() => {
    const id = `pipeline-fix-${process.pid}-${Math.random().toString(36).slice(2)}`;
    dir = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp', id);
    safeMkdir(dir, { recursive: true });
    file = path.join(dir, 'pipeline.json');
    rel = pathResolver.toRepoRelative(file);
    profileName = `${id}-profile`;
    cleanup = [dir, pathResolver.rootResolve(`${PROFILES}/${profileName}`)];
    preexisting = partitionDirs.map((entry) => safeExistsSync(entry));
  });
  afterEach(() => {
    for (const entry of cleanup) safeRmSync(entry, { recursive: true, force: true });
    partitionDirs.forEach((entry, index) => {
      if (!preexisting[index] && safeExistsSync(entry) && safeReaddir(entry).length === 0)
        safeRmdirSync(entry);
    });
  });

  it('places the backup on the artifact floor of the file partition, never beside the file', () => {
    const now = new Date('2026-11-26T01:02:03.000Z');
    expect(
      pipelineFixBackupTarget(
        {
          input_path: 'knowledge/confidential/acme/scenarios/run.json',
          tier: 'confidential',
          tenant_slug: 'acme',
        },
        now
      )
    ).toEqual({
      scope: { tenant: 'acme' },
      tier: 'confidential',
      artifact_class: 'export',
      name: 'pipeline-fix-backup/run.2026-11-26T01-02-03-000Z.json',
    });
    expect(
      pipelineFixBackupTarget({ input_path: 'pipelines/x.json', tier: 'public' }, now).scope
    ).toEqual({
      system: true,
    });
  });

  const profileDir = () => `${pathResolver.toRepoRelative(dir)}/${profileName}`;
  const read = () => String(safeReadFile(file, { encoding: 'utf8' }));

  it('dry run: coverage before/after, a diff, manual credential step, and the file untouched', async () => {
    const text = adfText(profileDir());
    safeWriteFile(file, text);
    const printed = await run();
    expect(printed).toContain(
      ' coverage  1 of 3 external step(s) pre-approvable → after fix: 2 of 3 external step(s) pre-approvable'
    );
    expect(printed.some((line) => line.startsWith(' fix       step 1 browser:evaluate'))).toBe(
      true
    );
    expect(printed).toContain(`           ${ARGS_SUGGESTION_CAVEAT}`);
    expect(printed.some((line) => /^ manual {4}step 2: .*carries a credential/u.test(line))).toBe(
      true
    );
    expect(printed).toContain(`--- a/${rel}`);
    expect(printed).toContain(`+  "options": { "user_data_dir": "${PROFILES}/${profileName}" },`);
    expect(printed.some((line) => line.startsWith(` next: pnpm pipeline fix ${rel} --write`))).toBe(
      true
    );
    expect(read()).toBe(text);
  });

  it('`pnpm pipeline fix <file>` reaches the command through the runner entry (dry run)', async () => {
    const text = adfText(profileDir());
    safeWriteFile(file, text);
    const printed: string[] = [];
    await runPipelineMain(resolvePipelinePresetArgs(['fix', rel]), (value) =>
      printed.push(String(value))
    );
    expect(printed.some((line) => line.startsWith(' coverage  1 of 3'))).toBe(true);
    expect(read()).toBe(text);
  });

  it('pnpm pipeline check points at pipeline fix when a rewrite exists', async () => {
    safeWriteFile(file, adfText(profileDir()));
    const printed: string[] = [];
    await runPipelineCheck({
      inputPath: rel,
      trustResolved: false,
      delegatedTrustRequested: false,
      json: false,
      print: (value) => printed.push(String(value)),
    }).catch(() => undefined);
    expect(printed.join('\n')).toContain(
      `next: pnpm pipeline fix ${rel} (dry run; --write applies it)`
    );
  });

  it('--write keeps a backup of the exact bytes and writes only the targeted values', async () => {
    const text = adfText(profileDir());
    safeWriteFile(file, text);
    const printed = await run({ write: true });
    const backupLine = printed.find((line) => line.startsWith(' backup    '));
    const backup = backupLine!.slice(' backup    '.length);
    expect(backup).toBe(
      `${pathResolver.toRepoRelative(dir)}/backup.${Date.parse('2026-11-26T01:02:03.000Z')}.json`
    );
    expect(String(safeReadFile(pathResolver.rootResolve(backup), { encoding: 'utf8' }))).toBe(text);
    const fixed = read();
    expect(fixed).toContain('"context": { "limit": 12345678901234567890 },');
    expect(fixed).toContain(
      `"script": "(a) => String(a.target).split(' | ')[0]", "args": { "target": "{{target}}" }`
    );
    expect(fixed).toContain("'{{env.PORTAL_TOKEN}}'");
    // A second run has nothing left to rewrite.
    expect(await run()).toContain(` next: nothing to rewrite — pnpm pipeline check ${rel}`);
  });

  it('--write refuses when the file changed after it was read', async () => {
    safeWriteFile(file, adfText(profileDir()));
    const edited = adfText(profileDir()).replace('pipeline-fix-cli', 'edited-meanwhile');
    await expect(
      run({ write: true, beforeWrite: () => safeWriteFile(file, edited) })
    ).rejects.toThrow(/\[PIPELINE_FIX_CHANGED\]/u);
    expect(read()).toBe(edited);
  });

  it('refuses a file whose duplicate keys a rewrite could not place safely', async () => {
    const text = adfText(profileDir()).replace(
      '"pipeline_id": "pipeline-fix-cli",',
      '"pipeline_id": "a",\n  "pipeline_id": "pipeline-fix-cli",'
    );
    safeWriteFile(file, text);
    await expect(run({ write: true })).rejects.toThrow(/\[PIPELINE_FIX_DUPLICATE_KEYS\]/u);
    expect(read()).toBe(text);
  });

  it('--move-profile: dry run describes the move, --write moves it, an existing target is refused', async () => {
    safeWriteFile(file, adfText(profileDir()));
    const source = pathResolver.rootResolve(profileDir());
    safeMkdir(source, { recursive: true });
    const target = pathResolver.rootResolve(`${PROFILES}/${profileName}`);
    // A folder that is not a browser profile is never moved.
    await expect(run({ write: true, moveProfile: true })).rejects.toThrow(
      /\[PIPELINE_FIX_PROFILE\].*does not look like a browser profile/u
    );
    safeWriteFile(path.join(source, 'Local State'), '{}');

    const dry = await run({ moveProfile: true });
    expect(dry).toContain(` profile   would move ${profileDir()} → ${PROFILES}/${profileName}`);
    expect(safeExistsSync(target)).toBe(false);

    safeMkdir(target, { recursive: true });
    const before = read();
    await expect(run({ write: true, moveProfile: true })).rejects.toThrow(
      /\[PIPELINE_FIX_PROFILE\].*already exists/u
    );
    expect(read()).toBe(before);
    expect(safeExistsSync(path.join(source, 'Local State'))).toBe(true);

    safeRmSync(target, { recursive: true, force: true });
    await run({ write: true, moveProfile: true });
    expect(safeExistsSync(path.join(target, 'Local State'))).toBe(true);
    expect(safeExistsSync(source)).toBe(false);
    expect(read()).toContain(`"user_data_dir": "${PROFILES}/${profileName}"`);
  });
});

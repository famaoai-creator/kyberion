import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { main } from './ingest.js';

// Hermetic: tenant profile, ledger, landing root and dedup registry all live
// under a uniquely named fixture root (the --root-dir seam).
describe('ingest dedup registration ordering', () => {
  let fixtureRoot = '';

  afterEach(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('registers the content hash only after the commit lands', async () => {
    fixtureRoot = pathResolver.sharedTmp(`ingest-dedup-ordering-${randomUUID()}`);
    const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    safeMkdir(tenantDir, { recursive: true });
    safeWriteFile(
      path.join(tenantDir, 'acme-corp.json'),
      JSON.stringify({
        tenant_slug: 'acme-corp',
        display_name: 'Acme',
        status: 'active',
        assigned_role: 'owner',
      })
    );
    const doc = path.join(fixtureRoot, 'board.md');
    safeWriteFile(doc, '# Board deck\n\nQuarterly results.\n');
    const registry = path.join(
      fixtureRoot,
      'active/shared/runtime/ingest/content-hash-registry.jsonl'
    );
    const ledger = path.join(fixtureRoot, 'knowledge/confidential/acme-corp/_ledger/assets.jsonl');
    const argv = [
      '--tenant',
      'acme-corp',
      '--file',
      doc,
      '--root-dir',
      fixtureRoot,
      '--ingested-by',
      'test',
    ];

    // A ledger path that is a directory makes the ceremony fail mid-way.
    safeMkdir(ledger, { recursive: true });
    await expect(main(argv)).rejects.toThrow(/regular file/);
    const afterFailure = safeExistsSync(registry)
      ? String(safeReadFile(registry, { encoding: 'utf8' }))
      : '';
    expect(afterFailure).toBe('');

    safeRmSync(ledger, { recursive: true, force: true });
    const output: unknown[] = [];
    await main(argv, (value) => output.push(value));
    expect(output.map(String).join('\n')).toContain('[ingest] committed');
    expect(
      String(safeReadFile(registry, { encoding: 'utf8' }))
        .trim()
        .split('\n')
    ).toHaveLength(1);
  });

  it('--reparse supersedes an unchanged source and is refused for any other duplicate', async () => {
    fixtureRoot = pathResolver.sharedTmp(`ingest-reparse-${randomUUID()}`);
    const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    safeMkdir(tenantDir, { recursive: true });
    safeWriteFile(
      path.join(tenantDir, 'acme-corp.json'),
      JSON.stringify({
        tenant_slug: 'acme-corp',
        display_name: 'Acme',
        status: 'active',
        assigned_role: 'owner',
      })
    );
    const doc = path.join(fixtureRoot, 'sheet.md');
    safeWriteFile(doc, '# Sheet\n\nMargin 33.5%.\n');
    const base = [
      '--tenant',
      'acme-corp',
      '--file',
      doc,
      '--root-dir',
      fixtureRoot,
      '--ingested-by',
      'test',
    ];
    const run = async (extra: string[]) => {
      const output: unknown[] = [];
      await main([...base, ...extra], (value) => output.push(value));
      return output.map(String).join('\n');
    };

    expect(await run(['--source-id', 'SHEET-1'])).toContain('committed asset:');
    expect(await run(['--source-id', 'SHEET-1'])).toContain('NOT committed (duplicate)');
    const reparsed = await run(['--source-id', 'SHEET-1', '--reparse']);
    expect(reparsed).toMatch(/committed asset:ing-[a-f0-9]+@v2/);
    expect(reparsed).toContain('"reparse"');
    // Same bytes under another source id: --reparse must not bypass dedup.
    await expect(main([...base, '--source-id', 'OTHER', '--reparse'])).rejects.toThrow(
      /--reparse only applies/
    );
  });

  it('dry-run lists the tenant folders and defaults the source id to the file name', async () => {
    fixtureRoot = pathResolver.sharedTmp(`ingest-folders-${randomUUID()}`);
    const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    safeMkdir(tenantDir, { recursive: true });
    safeWriteFile(
      path.join(tenantDir, 'acme-corp.json'),
      JSON.stringify({
        tenant_slug: 'acme-corp',
        display_name: 'Acme',
        status: 'active',
        assigned_role: 'owner',
      })
    );
    for (const folder of ['finance', 'governance', '_ledger']) {
      safeMkdir(path.join(fixtureRoot, 'knowledge/confidential/acme-corp', folder), {
        recursive: true,
      });
    }
    const doc = path.join(fixtureRoot, 'staged-dir', 'Board Deck.md');
    safeMkdir(path.dirname(doc), { recursive: true });
    safeWriteFile(doc, '# Board\n\nText.\n');
    const output: unknown[] = [];
    await main(
      [
        '--tenant',
        'acme-corp',
        '--file',
        doc,
        '--root-dir',
        fixtureRoot,
        '--ingested-by',
        'test',
        '--dry-run',
      ],
      (value) => output.push(value)
    );
    const text = output.map(String).join('\n');
    expect(text).toContain('Existing folders in acme-corp: finance, governance');
    expect(text).not.toContain('_ledger,');
    expect(text).toContain('source=file::Board Deck.md');
  });

  it('refuses up front, without reading, when the identity cannot read the tenant profile', async () => {
    fixtureRoot = pathResolver.sharedTmp(`ingest-identity-${randomUUID()}`);
    const doc = path.join(fixtureRoot, 'x.md');
    safeMkdir(fixtureRoot, { recursive: true });
    safeWriteFile(doc, '# X\n');
    const previous = { persona: process.env.KYBERION_PERSONA, role: process.env.MISSION_ROLE };
    delete process.env.KYBERION_PERSONA;
    delete process.env.MISSION_ROLE;
    try {
      await expect(
        main(['--tenant', 'acme-corp', '--file', doc, '--ingested-by', 'test', '--dry-run'])
      ).rejects.toThrow(/cannot read the tenant profile[\s\S]*MISSION_ROLE=mission_controller/);
    } finally {
      if (previous.persona !== undefined) process.env.KYBERION_PERSONA = previous.persona;
      if (previous.role !== undefined) process.env.MISSION_ROLE = previous.role;
    }
  });
});

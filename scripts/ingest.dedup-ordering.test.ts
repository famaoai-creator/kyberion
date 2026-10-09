import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as assetLedger from '@agent/core/ingest-asset-ledger';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { main } from './ingest.js';

// Hermetic: tenant profiles, ledgers, landing roots and legacy registry fixtures live
// under a uniquely named fixture root (the --root-dir seam).
describe('ingest tenant-local duplicate evidence', () => {
  let fixtureRoot = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  function prepareTenants() {
    fixtureRoot = pathResolver.sharedTmp(`ingest-tenant-scope-${randomUUID()}`);
    const tenantDir = path.join(fixtureRoot, 'knowledge/personal/tenants');
    safeMkdir(tenantDir, { recursive: true });
    for (const tenant of ['alpha', 'beta']) {
      safeWriteFile(
        path.join(tenantDir, tenant + '.json'),
        JSON.stringify({
          tenant_slug: tenant,
          display_name: tenant,
          status: 'active',
          assigned_role: 'owner',
        })
      );
    }
    const doc = path.join(fixtureRoot, 'report.md');
    safeWriteFile(doc, '# Report\n\nSynthetic shared content.\n');
    const run = async (tenant: string, extra: string[] = []) => {
      const output: unknown[] = [];
      await main(
        [
          '--tenant',
          tenant,
          '--file',
          doc,
          '--root-dir',
          fixtureRoot,
          '--ingested-by',
          'test',
          ...extra,
        ],
        (value) => output.push(value)
      );
      return output.map(String).join('\n');
    };
    const ledger = (tenant: string) =>
      path.join(fixtureRoot, 'knowledge/confidential', tenant, '_ledger/assets.jsonl');
    const registry = path.join(
      fixtureRoot,
      'active/shared/runtime/ingest/content-hash-registry.jsonl'
    );
    return { doc, run, ledger, registry };
  }

  it('files identical documents independently into each selected tenant', async () => {
    const { run } = prepareTenants();
    expect(await run('alpha')).toContain('committed asset:');
    const preview = await run('beta', ['--dry-run']);
    expect(preview).toContain('"would_commit": true');
    expect(preview).not.toContain('knowledge/confidential/alpha');
    expect(
      safeExistsSync(path.join(fixtureRoot, 'knowledge/confidential/beta/_ledger/assets.jsonl'))
    ).toBe(false);
    expect(await run('beta')).toContain('committed asset:');
    for (const tenant of ['alpha', 'beta']) {
      expect(
        safeExistsSync(path.join(fixtureRoot, 'knowledge/confidential', tenant, 'ingest/report.md'))
      ).toBe(true);
      expect(await run(tenant)).toContain('NOT committed (duplicate)');
      const ledger = String(
        safeReadFile(
          path.join(fixtureRoot, 'knowledge/confidential', tenant, '_ledger/assets.jsonl'),
          { encoding: 'utf8' }
        )
      );
      expect(ledger.trim().split('\n')).toHaveLength(1);
    }
  });

  it('ignores legacy global hashes without exposing or changing their records', async () => {
    const { doc, run, registry } = prepareTenants();
    const hash = createHash('sha256').update(safeReadFile(doc)).digest('hex');
    const legacy =
      JSON.stringify({
        content_sha256: hash,
        source_system: 'file',
        source_id: 'report.md',
        first_seen: '2026-10-01T00:00:00.000Z',
        target_path: 'knowledge/confidential/foreign-private/secret-report.md',
      }) + '\n';
    safeMkdir(path.dirname(registry), { recursive: true });
    safeWriteFile(registry, legacy);
    const preview = await run('alpha', ['--dry-run']);
    expect(preview).toContain('"would_commit": true');
    expect(preview).not.toContain('foreign-private');
    expect(preview).not.toContain('secret-report');
    const committed = await run('alpha');
    expect(committed).toContain('committed asset:');
    expect(committed).not.toContain('foreign-private');
    expect(String(safeReadFile(registry, { encoding: 'utf8' }))).toBe(legacy);
  });

  it('uses a committed tenant ledger after an interrupted legacy registry write', async () => {
    const { run, ledger, registry } = prepareTenants();
    // Old releases could append the ledger and then fail to register the hash.
    // Make that obsolete path unwritable as a file: the ceremony must ignore it.
    safeMkdir(registry, { recursive: true });
    expect(await run('alpha')).toContain('committed asset:');
    const before = String(safeReadFile(ledger('alpha'), { encoding: 'utf8' }));
    expect(await run('alpha', ['--dry-run'])).toContain('"would_commit": false');
    expect(await run('alpha')).toContain('NOT committed (duplicate)');
    expect(String(safeReadFile(ledger('alpha'), { encoding: 'utf8' }))).toBe(before);
  });

  it('keeps independent source version histories and historical duplicate behavior', async () => {
    const { doc, run, ledger } = prepareTenants();
    const original = String(safeReadFile(doc, { encoding: 'utf8' }));
    for (const tenant of ['alpha', 'beta']) expect(await run(tenant)).toContain('committed asset:');
    safeWriteFile(doc, '# Report\n\nRevised synthetic content.\n');
    expect(await run('beta')).toMatch(/committed asset:ing-[a-f0-9]+@v2/);
    const alphaBefore = String(safeReadFile(ledger('alpha'), { encoding: 'utf8' }));
    expect(alphaBefore.trim().split('\n')).toHaveLength(1);
    expect(await run('alpha', ['--dry-run'])).toContain('"would_commit": true');
    expect(String(safeReadFile(ledger('alpha'), { encoding: 'utf8' }))).toBe(alphaBefore);
    expect(await run('alpha')).toMatch(/committed asset:ing-[a-f0-9]+@v2/);
    safeWriteFile(doc, original);
    expect(await run('alpha')).toContain('NOT committed (duplicate)');
    await expect(run('alpha', ['--reparse'])).rejects.toThrow(/--reparse only applies/);
    for (const tenant of ['alpha', 'beta']) {
      expect(
        String(safeReadFile(ledger(tenant), { encoding: 'utf8' }))
          .trim()
          .split('\n')
      ).toHaveLength(2);
    }
  });

  it.each(['../alpha', 'alpha/../beta', 'ALPHA', 'unknown'])(
    'rejects invalid or unregistered destination %s',
    async (tenant) => {
      const { run, ledger } = prepareTenants();
      await expect(run(tenant, ['--dry-run'])).rejects.toThrow();
      expect(safeExistsSync(ledger('alpha'))).toBe(false);
      expect(safeExistsSync(ledger('beta'))).toBe(false);
    }
  );

  it('does not treat a failed ledger append as committed duplicate evidence', async () => {
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

    // Interrupt the actual append after commitIngest has written the card.
    const append = vi.spyOn(assetLedger, 'appendAssetRecord').mockImplementationOnce(() => {
      throw new Error('synthetic ledger append interrupted');
    });
    await expect(main(argv)).rejects.toThrow('synthetic ledger append interrupted');
    expect(append).toHaveBeenCalledTimes(1);
    expect(
      safeExistsSync(path.join(fixtureRoot, 'knowledge/confidential/acme-corp/ingest/board.md'))
    ).toBe(true);
    expect(safeExistsSync(ledger)).toBe(false);
    const afterFailure = safeExistsSync(registry)
      ? String(safeReadFile(registry, { encoding: 'utf8' }))
      : '';
    expect(afterFailure).toBe('');

    append.mockRestore();
    const output: unknown[] = [];
    await main(argv, (value) => output.push(value));
    expect(output.map(String).join('\n')).toContain('[ingest] committed');
    expect(safeExistsSync(registry)).toBe(false);
    const committedLedger = String(safeReadFile(ledger, { encoding: 'utf8' }));
    expect(committedLedger.trim().split('\n')).toHaveLength(1);
    const retryOutput: unknown[] = [];
    await main(argv, (value) => retryOutput.push(value));
    expect(retryOutput.map(String).join('\n')).toContain('NOT committed (duplicate)');
    expect(String(safeReadFile(ledger, { encoding: 'utf8' }))).toBe(committedLedger);
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
    const ledger = path.join(fixtureRoot, 'knowledge/confidential/acme-corp/_ledger/assets.jsonl');
    const beforeOtherSource = String(safeReadFile(ledger, { encoding: 'utf8' }));
    expect(await run(['--source-id', 'OTHER'])).toContain('NOT committed (duplicate)');
    expect(String(safeReadFile(ledger, { encoding: 'utf8' }))).toBe(beforeOtherSource);
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

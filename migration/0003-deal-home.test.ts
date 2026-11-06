import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
let listFiles: typeof import('./0003-deal-home.js').listFiles;
let relinkDealRefs: typeof import('./0003-deal-home.js').relinkDealRefs;
let runMigration: typeof import('./0003-deal-home.js').migrate;

describe('0003-deal-home migration', () => {
  let root = '';
  const sourceRoot = process.cwd();
  const auditKey = Symbol.for('@kyberion/audit-chain');
  let savedAudit: PropertyDescriptor | undefined;
  beforeAll(async () => {
    fs.mkdirSync(path.join(sourceRoot, 'active/shared/tmp'), { recursive: true });
    root = fs.mkdtempSync(path.join(sourceRoot, 'active/shared/tmp/deal-home-run-'));
    const { seedFirstJobTestRoot } =
      await import('../scripts/fixtures/first-job-approval-fixture.js');
    seedFirstJobTestRoot(sourceRoot, root);
    savedAudit = Object.getOwnPropertyDescriptor(globalThis, auditKey);
    process.chdir(root);
    vi.stubEnv('KYBERION_ROOT', root);
    vi.stubEnv('VITEST', '');
    Reflect.deleteProperty(globalThis, auditKey);
    vi.resetModules();
    ({ listFiles, relinkDealRefs, migrate: runMigration } = await import('./0003-deal-home.js'));
    const { pathResolver } = await import('@agent/core/path-resolver');
    expect(pathResolver.rootDir()).toBe(root);
    expect(pathResolver.primaryCheckoutRootDir()).toBe(root);
  }, 60000);
  beforeEach(() => {
    // Keep the real policy/authority stack cached; reset only synthetic inputs/outputs.
    fs.rmSync(path.join(root, 'customer'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'knowledge/confidential'), { recursive: true, force: true });
  });
  afterAll(() => {
    if (savedAudit) Object.defineProperty(globalThis, auditKey, savedAudit);
    else Reflect.deleteProperty(globalThis, auditKey);
    process.chdir(sourceRoot);
    vi.unstubAllEnvs();
    vi.resetModules();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists every deal file, nested documents and escalations included', () => {
    // secure-io only reads inside the repository: keep the fixture on the scratch floor.
    const deals = path.join(root, 'customer', 'acme', 'deals');
    fs.mkdirSync(path.join(deals, 'DEAL-1', 'escalations'), { recursive: true });
    for (const file of [
      'DEAL-1.json',
      'deal-log.jsonl',
      'DEAL-1/quote-v1.md',
      'DEAL-1/escalations/abc.json',
    ])
      fs.writeFileSync(path.join(deals, file), '{}');
    expect(listFiles(deals)).toEqual([
      'DEAL-1/escalations/abc.json',
      'DEAL-1/quote-v1.md',
      'DEAL-1.json',
      'deal-log.jsonl',
    ]);
  });

  function fixture() {
    const from = path.join(root, 'customer/acme/deals');
    const to = path.join(root, 'knowledge/confidential/acme/deals');
    fs.mkdirSync(from, { recursive: true });
    return { from, to };
  }

  it('preserves binary bytes while relinking JSON and JSONL during an actual migration', async () => {
    const { from, to } = fixture();
    const bytes = Buffer.from([0, 255, 254, 128, 13, 10, 65]);
    fs.writeFileSync(path.join(from, 'attachment.pdf'), bytes);
    for (const name of ['deal.json', 'deal-log.jsonl'])
      fs.writeFileSync(path.join(from, name), '{"ref":"customer/acme/deals/attachment.pdf"}');
    await runMigration({ dryRun: false });
    expect(fs.readFileSync(path.join(to, 'attachment.pdf'))).toEqual(bytes);
    for (const name of ['deal.json', 'deal-log.jsonl'])
      expect(fs.readFileSync(path.join(to, name), 'utf8')).toContain(
        'knowledge/confidential/acme/deals/attachment.pdf'
      );
    expect(fs.existsSync(from)).toBe(false);
  });

  it('dry-runs without creating a destination or changing source bytes', async () => {
    const { from, to } = fixture();
    const bytes = Buffer.from([0, 255]);
    fs.writeFileSync(path.join(from, 'attachment.pdf'), bytes);
    await runMigration({ dryRun: true });
    expect(fs.existsSync(to)).toBe(false);
    expect(fs.readFileSync(path.join(from, 'attachment.pdf'))).toEqual(bytes);
  });

  it('leaves an existing destination and source unchanged', async () => {
    const { from, to } = fixture();
    fs.writeFileSync(path.join(from, 'deal.json'), 'source');
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'deal.json'), 'target');
    await runMigration({ dryRun: false });
    expect(fs.readFileSync(path.join(from, 'deal.json'), 'utf8')).toBe('source');
    expect(fs.readFileSync(path.join(to, 'deal.json'), 'utf8')).toBe('target');
  });

  it.each([false, true])(
    'rejects unsupported entries before any tenant is changed (dryRun=%s)',
    async (dryRun) => {
      const { from, to } = fixture();
      fs.writeFileSync(path.join(from, 'deal.json'), '{}');
      const later = path.join(root, 'customer/zeta/deals');
      fs.mkdirSync(later, { recursive: true });
      fs.writeFileSync(path.join(later, 'kept.json'), '{}');
      fs.symlinkSync(path.join(later, 'kept.json'), path.join(later, 'linked.json'));
      await expect(runMigration({ dryRun })).rejects.toThrow(/unsupported|symbolic|linked/i);
      expect(fs.readFileSync(path.join(from, 'deal.json'), 'utf8')).toBe('{}');
      expect(fs.existsSync(to)).toBe(false);
      expect(fs.lstatSync(path.join(later, 'linked.json')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(root, 'knowledge/confidential/zeta/deals'))).toBe(false);
    }
  );

  it.each([false, true])(
    'rejects a README directory before any tenant is changed (dryRun=%s)',
    async (dryRun) => {
      const { from, to } = fixture();
      fs.writeFileSync(path.join(from, 'deal.json'), '{}');
      const readme = path.join(root, 'customer/README.md');
      fs.mkdirSync(readme);
      fs.writeFileSync(path.join(readme, 'kept.bin'), Buffer.from([255, 0]));
      await expect(runMigration({ dryRun })).rejects.toThrow(/README|unsupported/i);
      expect(fs.readFileSync(path.join(readme, 'kept.bin'))).toEqual(Buffer.from([255, 0]));
      expect(fs.readFileSync(path.join(from, 'deal.json'), 'utf8')).toBe('{}');
      expect(fs.existsSync(to)).toBe(false);
    }
  );

  it('refuses a linked README and preserves its target before copying tenant files', async () => {
    const { from, to } = fixture();
    fs.writeFileSync(path.join(from, 'deal.json'), '{}');
    const target = path.join(root, 'readme-target');
    fs.writeFileSync(target, 'keep');
    const readme = path.join(root, 'customer/README.md');
    fs.symlinkSync(target, readme);
    await expect(runMigration({ dryRun: false })).rejects.toThrow(/README|unsupported/i);
    expect(fs.lstatSync(readme).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(from, 'deal.json'))).toBe(true);
    expect(fs.existsSync(to)).toBe(false);
  });

  it('removes an ordinary legacy README only after all tenant files migrate', async () => {
    const { from, to } = fixture();
    fs.writeFileSync(path.join(from, 'deal.json'), '{}');
    fs.writeFileSync(path.join(root, 'customer/README.md'), '# legacy');
    await runMigration({ dryRun: false });
    expect(fs.readFileSync(path.join(to, 'deal.json'), 'utf8')).toBe('{}');
    expect(fs.existsSync(path.join(root, 'customer'))).toBe(false);
  });

  it('relinks references to the legacy deal folder and leaves others alone', () => {
    const deal = JSON.stringify({
      quote_ref: 'customer/acme/deals/DEAL-1/quote-v1.md',
      other: 'customer/beta/deals/DEAL-9/quote-v1.md',
    });
    expect(JSON.parse(relinkDealRefs(deal, 'acme'))).toEqual({
      quote_ref: 'knowledge/confidential/acme/deals/DEAL-1/quote-v1.md',
      other: 'customer/beta/deals/DEAL-9/quote-v1.md',
    });
  });
});

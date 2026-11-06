import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFiles, relinkDealRefs } from './0003-deal-home.js';

describe('0003-deal-home migration', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists every deal file, nested documents and escalations included', () => {
    // secure-io only reads inside the repository: keep the fixture on the scratch floor.
    fs.mkdirSync(path.join(process.cwd(), 'active/shared/tmp'), { recursive: true });
    root = fs.mkdtempSync(path.join(process.cwd(), 'active/shared/tmp/deal-home-'));
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

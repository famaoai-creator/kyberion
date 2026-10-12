import { describe, expect, it } from 'vitest';
import { terraformIrToAssetInventory } from './terraform-asset-inventory.js';
import { iacInventoryToLedgerDraft } from './asset-ledger.js';
import type { TerraformBlock, TerraformTopologyIr } from './topology-ir.js';

function block(
  kind: string,
  type: string,
  name: string,
  body: string,
  dir = 'test'
): TerraformBlock {
  const id = `${dir}::${kind}.${type}${name ? `.${name}` : ''}`;
  return { kind, type, name, id, dir, body, filePath: `/root/${dir}/main.tf` } as TerraformBlock;
}

function ir(blocks: TerraformBlock[]): TerraformTopologyIr {
  return {
    exampleRoot: 'test',
    exampleName: 'test',
    tfFiles: [],
    runtimeBlocks: blocks.filter((b) =>
      ['provider', 'resource', 'data', 'module', 'backend'].includes(b.kind)
    ),
    allBlocks: blocks,
    callerBlocksBySource: {},
    moduleSourceDirs: [],
  } as TerraformTopologyIr;
}

const SAMPLE = ir([
  block('provider', 'aws', '', ''),
  block('module', 'm', '', 'source = "git::https://github.com/org/mod.git"'),
  block(
    'resource',
    'aws_security_group',
    'web',
    `ingress {
    from_port = 443
    to_port = 443
    protocol = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }`
  ),
  block('resource', 'aws_elb', 'pub', 'security_groups = ["${aws_security_group.web.id}"]'),
  block('resource', 'aws_db_instance', 'db', 'publicly_accessible = true'),
  block('output', 'elb_dns', '', 'value = "${aws_elb.pub.dns_name}"'),
]);

describe('iacInventoryToLedgerDraft', () => {
  it('maps services, candidates, and data stores into ledger entries', () => {
    const draft = iacInventoryToLedgerDraft(terraformIrToAssetInventory(SAMPLE));
    const ids = draft.entries.map((e) => e.service_id);
    expect(ids).toContain('svc:aws');
    expect(ids).toContain('svc:github');
    expect(ids.some((id) => id.includes('aws-security-group-web'))).toBe(true);
    expect(ids.some((id) => id.includes('aws-db-instance-db'))).toBe(true);
    const db = draft.entries.find((e) => e.name === 'aws_db_instance.db')!;
    expect(db.category).toBe('data-store');
    expect(db.exposure).toBe('public');
    const elb = draft.entries.find((e) => e.name === 'aws_elb.pub')!;
    expect(elb.category).toBe('published-app');
    // `output.elb_dns` references ${aws_elb.pub.dns_name} — endpoint evidence.
    expect(elb.endpoints.some((ep) => ep.includes('aws_elb.pub.dns_name'))).toBe(true);
  });

  it('keeps honest unknowns and marks entries shadow/pending for review', () => {
    const draft = iacInventoryToLedgerDraft(terraformIrToAssetInventory(SAMPLE));
    for (const e of draft.entries) {
      expect(e.review_status).toBe('pending');
      expect(e.shadow).toBe(true);
      expect(e.auth_method).toBe('unknown');
      expect(e.mfa_status).toBe('unknown');
      expect(e.data_classification).toBe('unknown');
      expect(e.discovery_sources).toEqual(['S-8']);
    }
    expect(draft.stats.shadow).toBe(draft.stats.entries);
  });

  it('attaches signal rules, evidence, and unresolved refs to provenance', () => {
    const inv = terraformIrToAssetInventory(SAMPLE);
    const draft = iacInventoryToLedgerDraft(inv);
    const sg = draft.entries.find((e) => e.name === 'aws_security_group.web')!;
    expect(sg.exposure).toBe('public');
    expect(sg.provenance.signal_rules).toContain('EXPOSURE_OPEN_INGRESS');
    expect(sg.provenance.source_op).toBe('modeling:terraform_asset_inventory');
  });

  it('maps state backends to data-store entries and dns values to service endpoints', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('backend', 's3', '', 'bucket = "state-bucket"'),
        block('data', 'terraform_remote_state', 'db', 'backend = "s3"\nconfig { bucket = "b" }'),
        block(
          'resource',
          'aws_route53_record',
          'app',
          `type = "CNAME"
        name = "app.example.com"
        records = ["app.herokuapp.com"]`
        ),
      ])
    );
    const draft = iacInventoryToLedgerDraft(inv);
    const backends = draft.entries.filter((e) => e.service_id.startsWith('asset:backend'));
    expect(backends).toHaveLength(2);
    for (const b of backends) expect(b.category).toBe('data-store');
    const heroku = draft.entries.find((e) => e.service_id === 'svc:heroku')!;
    expect(heroku.endpoints).toContain('app.herokuapp.com');
  });

  it('clears shadow when caller supplies owner and contract', () => {
    const draft = iacInventoryToLedgerDraft(terraformIrToAssetInventory(SAMPLE), {
      owner: 'platform-team',
      contractRef: 'PO-123',
      asOf: '2026-10-12',
    });
    for (const e of draft.entries) {
      expect(e.shadow).toBe(false);
      expect(e.owner).toBe('platform-team');
      expect(e.contract_ref).toBe('PO-123');
      expect(e.last_verified).toBe('2026-10-12');
    }
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { resetAgentIdentityServiceForTests } from '@agent/core/agent/agent-identity';
import { main } from './nhi.js';

function capture(): { out: string[]; print: (value: unknown) => void } {
  const out: string[] = [];
  return { out, print: (value) => out.push(String(value)) };
}

describe('nhi CLI', () => {
  beforeEach(() => {
    resetAgentIdentityServiceForTests(
      pathResolver.sharedTmp(`nhi-test-${Math.random().toString(36).slice(2)}.jsonl`)
    );
  });

  it('dry-run issue prints the would-be NHI without writing', () => {
    const { out, print } = capture();
    main(
      [
        'issue',
        '--slug',
        'devin-sim-agent',
        '--organization-id',
        'acme-org',
        '--accountable-human',
        'human:alice',
      ],
      print
    );
    const parsed = JSON.parse(out[0]);
    expect(parsed.status).toBe('dry-run');
    expect(parsed.would_issue.nhi_id).toBe('kyberion://agent/acme-org/devin-sim-agent');
  });

  it('issues, lists, and stays idempotent on identical re-issue', () => {
    const { print } = capture();
    const issue = [
      'issue',
      '--slug',
      'devin-sim-agent',
      '--organization-id',
      'acme-org',
      '--accountable-human',
      'human:alice',
      '--tenant-slug',
      'acme-tenant',
      '--apply',
    ];
    main(issue, print);
    // Identical re-issue is idempotent — the same record, not a conflict.
    main(issue, print);

    const { out, print: listPrint } = capture();
    main(['list', '--organization-id', 'acme-org'], listPrint);
    const records = JSON.parse(out[0]);
    expect(records).toHaveLength(1);
    expect(records[0].nhi_id).toBe('kyberion://agent/acme-org/devin-sim-agent');
    expect(records[0].lifecycle_status).toBe('provisioned');
  });

  it('rejects a missing accountable human on apply', () => {
    const { print } = capture();
    expect(() =>
      main(['issue', '--slug', 'rogue-agent', '--organization-id', 'acme-org', '--apply'], print)
    ).toThrow();
  });

  it('drives the full lifecycle: issue -> suspend -> resume -> retire', () => {
    const { print } = capture();
    main(
      [
        'issue',
        '--slug',
        'ops-agent',
        '--organization-id',
        'acme-org',
        '--accountable-human',
        'human:alice',
        '--apply',
      ],
      print
    );
    const nhi = 'kyberion://agent/acme-org/ops-agent';
    main(['suspend', nhi, '--reason', 'maintenance', '--apply'], print);
    main(['resume', nhi, '--apply'], print);
    main(['retire', nhi, '--reason', 'replaced by ops-agent-v2', '--apply'], print);

    // Retired identities are terminal: re-issue under the same slug conflicts.
    expect(() =>
      main(
        [
          'issue',
          '--slug',
          'ops-agent',
          '--organization-id',
          'acme-org',
          '--accountable-human',
          'human:alice',
          '--apply',
        ],
        print
      )
    ).toThrow();
  });

  it('requires --reason for retire even in dry-run', () => {
    const { print } = capture();
    expect(() => main(['retire', 'kyberion://agent/acme-org/x'], print)).toThrow(
      /retire requires --reason/
    );
  });
});

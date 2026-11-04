import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { resetAgentIdentityServiceForTests } from '@agent/core/agent/agent-identity';
import { main } from './nhi.js';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import {
  loadPersonalAgentIdentityAtPath,
  writePersonalAgentIdentityAtPath,
} from '@agent/core/personal-identity-state';

vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () =>
    `${process.cwd()}/active/shared/tmp/nhi-persona-cli-${process.pid}`,
}));
const profileRoot = `${process.cwd()}/active/shared/tmp/nhi-persona-cli-${process.pid}`;
afterEach(() =>
  withExecutionContext('mission_controller', () =>
    safeRmSync(profileRoot, { recursive: true, force: true })
  )
);

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

  it('previews and persists an explicit persona map without issuing or activating identities', () => {
    main([
      'issue',
      '--slug',
      'haru',
      '--organization-id',
      'personal',
      '--accountable-human',
      'user:owner',
      '--apply',
    ]);
    const binding = {
      version: 1,
      persona_id: 'haru',
      accountable_human_id: 'user:owner',
      personal_nhi_id: 'kyberion://agent/personal/haru',
      tenant_bindings: [],
    };
    const file = `${profileRoot}/agent-identity.json`;
    const input = `${profileRoot}/bindings.json`;
    withExecutionContext('mission_controller', () => {
      writePersonalAgentIdentityAtPath(file, {
        agent_id: 'haru',
        nhi_id: binding.personal_nhi_id,
        custom_field: 'preserved',
      });
      safeWriteFile(input, JSON.stringify(binding));
    });
    const { out, print } = capture();
    main(['persona-bind', '--bindings', input], print);
    expect(JSON.parse(out[0]).status).toBe('dry-run');
    expect(loadPersonalAgentIdentityAtPath(file)?.persona_identity_bindings).toBeUndefined();
    const revision = JSON.parse(out[0]).expected_revision;
    main(['persona-bind', '--bindings', input, '--apply', '--expected-revision', revision], print);
    expect(() =>
      main(['persona-bind', '--bindings', input, '--apply', '--expected-revision', revision])
    ).toThrow(/profile changed/);
    expect(loadPersonalAgentIdentityAtPath(file)).toMatchObject({
      custom_field: 'preserved',
      nhi_id: binding.personal_nhi_id,
      persona_identity_bindings: binding,
    });
    main(['persona-show'], print);
    expect(JSON.parse(out[2]).bindings).toEqual(binding);
    const listing = capture();
    main(['list'], listing.print);
    expect(JSON.parse(listing.out[0])).toHaveLength(1);
    expect(JSON.parse(listing.out[0])[0].lifecycle_status).toBe('provisioned');
    main(['suspend', binding.personal_nhi_id, '--apply']);
    expect(() => main(['persona-bind', '--bindings', input, '--apply'])).toThrow(
      /current, matching/
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

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/authority';
import { auditChain } from '@agent/core/governance/audit-chain';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { PROVIDER_ATTESTATION_APPROVAL_CHANNEL } from '@agent/core/organization/tenant-governance';
import { main } from './tenant.js';

describe('tenant CLI output boundary', () => {
  it('keeps tenant governance output free of direct console output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/tenant.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });

  it('routes help output through the supplied printer', () => {
    const output: unknown[] = [];

    main(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(String(output[0])).toContain('Usage: pnpm tenant');
  });
});

describe('tenant attest-provider requires --apply --accept', () => {
  const rootDir = pathResolver.sharedTmp(`tenant-attest-cli-${process.pid}`);
  let record: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
    withExecutionContext('sovereign_concierge', () => {
      safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
      safeWriteFile(
        path.join(rootDir, 'knowledge', 'personal', 'tenants', 'acme.json'),
        JSON.stringify({
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
        })
      );
    });
    record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    record.mockRestore();
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  const attestation = () =>
    withExecutionContext('sovereign_concierge', () => readTenantProfile('acme', { rootDir }))
      ?.provider_attestations?.codex;
  const args = ['attest-provider', 'acme', '--provider', 'codex', '--training-use', 'used'];

  it('does not write with --apply alone', () => {
    expect(() => main([...args, '--apply'], () => undefined, { rootDir })).toThrow(
      /requires --accept/
    );
    expect(attestation()).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('writes and audits with --apply --accept', () => {
    main([...args, '--apply', '--accept'], () => undefined, { rootDir });
    expect(attestation()).toMatchObject({ training_use: 'used' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.attest_provider', tenantSlug: 'acme' })
    );
  });

  it('does not write training_use none without an approved request', () => {
    expect(() =>
      main(
        [
          'attest-provider',
          'acme',
          '--provider',
          'codex',
          '--training-use',
          'none',
          '--plan',
          'Enterprise',
          '--basis',
          'https://example.com/terms',
          '--attested-by',
          'human:owner',
          '--apply',
          '--accept',
        ],
        () => undefined,
        { rootDir }
      )
    ).toThrow(/needs a human approval/);
    expect(attestation()).toBeUndefined();
  });
});

describe('tenant attest-provider --request-approval prints an apply command that works as-is', () => {
  const rootDir = pathResolver.sharedTmp(`tenant-attest-printed-${process.pid}`);
  const requestIds: string[] = [];
  let record: ReturnType<typeof vi.spyOn>;

  /** POSIX word splitting for bare words and single quotes; unquoted metacharacters fail. */
  function shellWords(command: string): string[] {
    const words: string[] = [];
    let current = '';
    let inWord = false;
    for (let i = 0; i < command.length; i += 1) {
      const ch = command[i]!;
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) throw new Error(`unterminated quote in: ${command}`);
        current += command.slice(i + 1, end);
        i = end;
        inWord = true;
      } else if (ch === '\\') {
        current += command[++i] ?? '';
        inWord = true;
      } else if (/\s/.test(ch)) {
        if (inWord) words.push(current);
        current = '';
        inWord = false;
      } else if (/[;&|<>$`"(){}*?#~!]/.test(ch)) {
        throw new Error(`unquoted shell metacharacter '${ch}' in: ${command}`);
      } else {
        current += ch;
        inWord = true;
      }
    }
    if (inWord) words.push(current);
    return words;
  }

  beforeEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
    withExecutionContext('sovereign_concierge', () => {
      safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
      safeWriteFile(
        path.join(rootDir, 'knowledge', 'personal', 'tenants', 'acme.json'),
        JSON.stringify({
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
        })
      );
    });
    record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    record.mockRestore();
    for (const id of requestIds.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id), {
        force: true,
      });
    }
    safeRmSync(approvalEventLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL), { force: true });
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('quotes every bound value so the pasted command applies', () => {
    const output: unknown[] = [];
    main(
      [
        'attest-provider',
        'acme',
        '--provider',
        'codex',
        '--training-use',
        'none',
        '--plan',
        "ChatGPT Enterprise (Acme's org)",
        '--basis',
        'https://example.com/terms?a=1&b=2',
        '--attested-by',
        'human:owner',
        '--valid-for-days',
        '30',
        '--request-approval',
      ],
      (value) => output.push(value),
      { rootDir }
    );
    const request = JSON.parse(String(output[0]));
    requestIds.push(request.request_id);
    const printed = String(request.next[1]).replace(/^Then apply: /, '');
    expect(printed).not.toContain('...');
    const words = shellWords(printed);
    expect(words.slice(0, 2)).toEqual(['pnpm', 'tenant']);

    const pending = loadApprovalRequest(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, request.request_id)!;
    decideApprovalRequest('mission_controller', {
      channel: pending.channel,
      storageChannel: pending.storageChannel,
      requestId: pending.id,
      decision: 'approved',
      decidedBy: 'human-owner',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: pending.accountability?.payloadHash,
      effectBinding: pending.accountability?.effectBinding,
    });

    main(words.slice(2), () => undefined, { rootDir });
    expect(
      withExecutionContext('sovereign_concierge', () => readTenantProfile('acme', { rootDir }))
        ?.provider_attestations?.codex
    ).toMatchObject({ training_use: 'none', plan: "ChatGPT Enterprise (Acme's org)" });
  });
});

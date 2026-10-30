import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import {
  evaluateOperationArguments,
  defaultOperationInterface,
  operationInterfaceResolver,
  withOperationArgumentOrigins,
} from './operation-protection.js';
import { registerMemoryProvenance, revokeMemorySource } from '../knowledge/memory-provenance.js';

const cleanup = new Set<string>();
const governed = <T>(action: () => T) =>
  withExecutionContext('mission_controller', action, 'ecosystem_architect');
afterEach(() =>
  governed(() => {
    for (const file of cleanup) safeRmSync(file, { recursive: true, force: true });
    cleanup.clear();
  })
);

describe('live operation interface and argument-origin protection', () => {
  it('resolves live reviewed builtin interfaces for direct callers and leaves unknown operations unbound', () =>
    governed(() => {
      for (const op of [
        'email:send',
        'browser:goto',
        'vcs:push',
        'meeting:chat',
        'calendar:create_event',
        'service:slack:preset:post_message',
        'tenant:attest_provider',
        'network:fetch',
        'network:a2a_send',
        'deployment:deploy_release',
        'voice:speak',
        'voice:record_sample',
        'video:filter_apply',
        'media:image:fixture:generate',
        'media:video:fixture:submit',
      ]) {
        const binding = defaultOperationInterface(op);
        expect(binding?.tool).toBe(op);
        expect(binding?.schema_digest).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(defaultOperationInterface('unreviewed:execute')).toBeUndefined();
      expect(defaultOperationInterface('video:unreviewed')).toBeUndefined();
    }));
  it('fingerprints transitive schema bytes and current candidate/description changes without catalog cache', () =>
    governed(() => {
      const dir = `active/shared/tmp/interface-${randomUUID()}`;
      cleanup.add(pathResolver.rootResolve(dir));
      const manifest = {
        capabilities: [{ op: 'send', schema_ref: `${dir}/schema.json`, description: 'send' }],
      };
      safeWriteFile(`${dir}/manifest.json`, JSON.stringify(manifest));
      safeWriteFile(`${dir}/schema.json`, JSON.stringify({ $ref: './recipient.json' }));
      safeWriteFile(`${dir}/recipient.json`, JSON.stringify({ type: 'string' }));
      const resolve = operationInterfaceResolver({
        op: 'test:send',
        manifestPath: `${dir}/manifest.json`,
      });
      const original = resolve();
      expect(resolve()).toEqual(original);
      safeWriteFile(`${dir}/recipient.json`, JSON.stringify({ type: 'number' }));
      expect(resolve().schema_digest).not.toBe(original.schema_digest);
      expect(resolve().capability_digest).toBe(original.capability_digest);
      manifest.capabilities[0]!.description = 'new semantics';
      manifest.capabilities.push({
        op: 'send_other',
        schema_ref: `${dir}/schema.json`,
        description: 'other',
      });
      safeWriteFile(`${dir}/manifest.json`, JSON.stringify(manifest));
      expect(resolve().capability_digest).not.toBe(original.capability_digest);
      expect(resolve().candidate_set).toEqual(['send', 'send_other']);
    }));

  it.each([
    ['email:send', { params: { to: 'a@example.com', body: 'untrusted body' } }, ['params', 'to']],
    [
      'service:slack:preset:post_message',
      { params: { channel: 'C1', text: 'external text' } },
      ['params', 'channel'],
    ],
    ['browser:goto', { params: { url: 'https://example.com' } }, ['params', 'url']],
    ['vcs:push', { url: 'https://example.com/a/b', destination: 'main' }, ['url']],
  ] as const)('checks reviewed real effect paths for %s', (operation, effect, protectedPath) => {
    expect(evaluateOperationArguments(operation, effect).requiresExactApproval).toBe(true);
    const segments = [...protectedPath];
    const value = segments.reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      effect
    );
    const ref = {
      path: segments,
      value_hash: computeApprovalPayloadHash({ value }),
      authority: 'user' as const,
    };
    const result = withOperationArgumentOrigins([ref], () =>
      evaluateOperationArguments(operation, effect)
    );
    // VCS additionally checks branch; authorizing only its repository cannot authorize the branch.
    expect(result.requiresExactApproval).toBe(operation === 'vcs:push');
    expect(
      withOperationArgumentOrigins(
        [{ ...ref, authority: 'external' }],
        () => evaluateOperationArguments(operation, effect).requiresExactApproval
      )
    ).toBe(true);
    expect(
      withOperationArgumentOrigins(
        [{ ...ref, value_hash: 'forged' }],
        () => evaluateOperationArguments(operation, effect).requiresExactApproval
      )
    ).toBe(true);
  });

  it('unknown/nested target shapes never become unprotected, and JSON authority labels do not grant', () => {
    const effect = { params: { envelope: { payee: 'attacker' } }, authority: 'user' };
    expect(
      evaluateOperationArguments('service:bank:preset:pay', effect).requiresExactApproval
    ).toBe(true);
    expect(
      withOperationArgumentOrigins(
        [
          {
            path: ['params'],
            value_hash: computeApprovalPayloadHash({ value: effect.params }),
            authority: 'policy',
          },
        ],
        () => evaluateOperationArguments('service:bank:preset:pay', effect).requiresExactApproval
      )
    ).toBe(false);
  });

  it('rechecks durable transitive source revocation even for host-attested authority', () =>
    governed(() => {
      const tenant = `arg-source-${randomUUID().slice(0, 8)}`;
      const scope = { tier: 'confidential' as const, tenant_slug: tenant };
      const dir = `knowledge/confidential/${tenant}`;
      cleanup.add(pathResolver.rootResolve(dir));
      cleanup.add(pathResolver.rootResolve(`active/shared/runtime/tenants/${tenant}`));
      safeWriteFile(`${dir}/source.md`, 'approved recipient');
      safeWriteFile(`${dir}/summary.md`, 'recipient summary');
      const source = registerMemoryProvenance({ scope, documentPath: `${dir}/source.md` });
      const derived = registerMemoryProvenance({
        scope,
        documentPath: `${dir}/summary.md`,
        origins: [source],
      });
      const effect = { params: { to: 'a@example.com' } };
      withOperationArgumentOrigins(
        [
          {
            path: ['params', 'to'],
            value_hash: computeApprovalPayloadHash({ value: 'a@example.com' }),
            authority: 'user',
            source: { ...derived, scope },
          },
        ],
        () => {
          expect(evaluateOperationArguments('email:send', effect).requiresExactApproval).toBe(
            false
          );
          revokeMemorySource(scope, source.source_id, 'compromised');
          expect(() => evaluateOperationArguments('email:send', effect)).toThrow(
            'OP_ARGUMENT_SOURCE_REVOKED'
          );
        }
      );
    }));
});

/** Subject-axis boundary: every authorization declaration axis resolves
 * through the unified registry with its detail semantics intact. */
import { describe, expect, it } from 'vitest';
import {
  declaredOperationPatterns,
  declaredSubjectKeys,
  subjectAuthorization,
} from '@agent/core/foundation/authorization-registry';
import { declaredApprovalDomains } from '@agent/core/foundation/approval-domains';
// Registers the governed file overlay (carries the service: family default).
import '@agent/core/governance/authorization-overlay';
// Importing each detail layer registers its subject-axis bridge.
import {
  cliCommandCredentialRequirement,
  missionActionCredentialRequirement,
} from '@agent/core/foundation/command-credential-policy';
import { loadApprovalPolicy } from '@agent/core/governance/approval-policy';
import { listGrantCapabilities } from '@agent/core/governance/grant-capability-policy';
import { PROTECTED_ARGUMENTS } from '@agent/core/governance/operation-protection';

describe('subject axis bridges', () => {
  it('every intent_ids entry of approval-policy.json resolves declared on the intent axis', () => {
    const rules = loadApprovalPolicy().rules ?? [];
    const intentIds = [...new Set(rules.flatMap((r) => r.intent_ids ?? []))];
    expect(intentIds.length).toBeGreaterThan(0);
    expect([...declaredSubjectKeys('intent')].sort()).toEqual([...intentIds].sort());
    for (const id of intentIds) {
      const auth = subjectAuthorization(`intent:${id}`);
      expect({ id, declared: auth.declared }).toEqual({ id, declared: true });
      expect(auth.effectClass).toBe('internal_decision');
      expect(['approval', 'admission']).toContain(auth.authority.kind);
      expect(auth.detail?.kind).toBe('approval-policy-rule');
    }
  });

  it('intent axis carries the strongest rule authority (assurance / dual-key)', () => {
    // vault:write: A3 + dual_key_confirmation → the subject inherits both.
    const auth = subjectAuthorization('intent:vault:write');
    expect(auth.authority).toEqual({ kind: 'approval', assurance: 'A3', dualKey: true });
    // inspect-service's rule is payload-conditional approval — the declared
    // subject authority is the strongest it can attract, so approval.
    expect(subjectAuthorization('intent:inspect-service').authority).toEqual({
      kind: 'approval',
    });
    // An undeclared intent fails to a human approval, never weaker.
    const undeclared = subjectAuthorization('intent:not-in-the-policy');
    expect(undeclared.declared).toBe(false);
    expect(undeclared.authority).toEqual({ kind: 'approval' });
  });

  it('every grant-capability-policy capability resolves declared on the capability axis', () => {
    const capabilities = listGrantCapabilities();
    expect(capabilities.length).toBeGreaterThan(0);
    expect([...declaredSubjectKeys('capability')].sort()).toEqual([...capabilities].sort());
    for (const capability of capabilities) {
      const auth = subjectAuthorization(`capability:${capability}`);
      expect({ capability, declared: auth.declared }).toEqual({ capability, declared: true });
      expect(auth.authority.kind).toBe('binding');
      expect(auth.detail).toEqual({ kind: 'grant-capability', capability });
    }
    // An undeclared capability binds at the stricter tenant scope.
    const undeclared = subjectAuthorization('capability:not-a-capability');
    expect(undeclared.authority).toEqual({ kind: 'binding', scope: 'tenant' });
  });

  it('verb axis stays in lockstep with the credential requirement resolvers', () => {
    for (const action of ['help', 'create', 'memory-promote', 'finish']) {
      const auth = subjectAuthorization(`verb:mission:${action}`);
      expect(auth.declared).toBe(true);
      expect(auth.detail).toEqual({
        kind: 'credential-requirement',
        requirement: missionActionCredentialRequirement(action),
      });
    }
    for (const [command, subcommand] of [
      ['list', undefined],
      ['email', 'status'],
      ['email', 'latest-draft'],
      ['calendar', 'status'],
      ['task', 'scenario'],
      ['deploy', undefined],
    ] as const) {
      const auth = subjectAuthorization(`verb:cli:${command}${subcommand ? `:${subcommand}` : ''}`);
      expect(auth.detail).toEqual({
        kind: 'credential-requirement',
        requirement: cliCommandCredentialRequirement({ command, subcommand }),
      });
    }
    expect(declaredSubjectKeys('verb').length).toBeGreaterThan(0);
  });
});

describe('subject declaration integrity', () => {
  it('every declared approvalDomain refers to a declared approval domain', () => {
    const domains = new Set(declaredApprovalDomains());
    const violations: string[] = [];
    // Exact ids only — prefix patterns cannot be probed for fields.
    const opIds = declaredOperationPatterns().filter((p) => !p.endsWith('*'));
    for (const id of opIds) {
      const domain = subjectAuthorization(id).approvalDomain;
      if (domain && !domains.has(domain)) violations.push(`${id}→${domain}`);
    }
    for (const axis of ['intent', 'capability', 'verb'] as const) {
      const prefix = `${axis}:`;
      for (const key of declaredSubjectKeys(axis)) {
        const domain = subjectAuthorization(`${prefix}${key}`).approvalDomain;
        if (domain && !domains.has(domain)) violations.push(`${prefix}${key}→${domain}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('registry protectedPaths are exactly the PROTECTED_ARGUMENTS table plus its service fallback', () => {
    for (const [op, paths] of Object.entries(PROTECTED_ARGUMENTS)) {
      expect({ op, paths: subjectAuthorization(op).protectedPaths }).toEqual({ op, paths });
    }
    // The folded service: family fallback lives in the governed overlay — data
    // layer so a plugin's own `service:<provider>` declarations still win.
    const svc = subjectAuthorization('service:unseen-provider:preset:op');
    expect(svc.declared).toBe(true);
    expect(svc.source).toBe('overlay');
    expect(svc.protectedPaths).toEqual([['params']]);
  });
});

/**
 * Boundary gate for the P4 Cedar-compatible serialization form.
 *
 * The load-bearing check is meaning preservation: `evaluatePolicyDocument`
 * (pure evaluator over the serialized document alone) must reproduce the
 * decision derived from live `subjectAuthorization` resolution for every
 * declared subject across every axis, and for every axis fail-safe. Probe
 * contexts cover approval/assurance/dual-key, admission, binding scope, and
 * the degraded-credential path.
 *
 * Note (review #9): both evaluators share `authorityPolicyShape`/
 * `conditionsMet`, so this gate verifies serialization + winner-selection
 * fidelity — that the document carries everything needed to reproduce the
 * resolution — not the authority→decision mapping against an external
 * oracle. The mapping itself is the contract under test elsewhere.
 */
import { describe, expect, it } from 'vitest';

import '@agent/core/governance/authorization-overlay';
import '@agent/core/governance/approval-policy';
import '@agent/core/governance/grant-capability-policy';
import '@agent/core/foundation/command-credential-policy';
import {
  declaredAuthorizationEntries,
  setAuthorizationOverlayProvider,
  subjectAuthorization,
  type AssuranceClass,
  type AuthorizationOverlay,
  type SubjectAxis,
} from '@agent/core/foundation/authorization-registry';
import {
  cedarDocumentText,
  cedarPolicyText,
  evaluateEntry,
  evaluatePolicyDocument,
  normalizeAuthorizationRequest,
  serializeRegistryDocument,
  type AuthorizationDecision,
  type NormalizedAuthorizationRequest,
} from '@agent/core/foundation/authorization-policy-document';

const AXES: readonly SubjectAxis[] = ['operation', 'intent', 'capability', 'verb'];

function request(subject: string, context: NormalizedAuthorizationRequest['context'] = {}) {
  return normalizeAuthorizationRequest({
    principal: { id: 'probe', kind: 'agent' },
    action: { subject },
    context,
  });
}

/** Probe matrix — every context a granted_when clause can read. */
const PROBE_CONTEXTS: readonly NormalizedAuthorizationRequest['context'][] = [
  {},
  { approved: true },
  { approved: true, assurance: 'A1' },
  { approved: true, assurance: 'A2' },
  { approved: true, assurance: 'A3' },
  { approved: true, assurance: 'A3', dualKey: true },
  { admissionGranted: 'external' },
  { admissionGranted: 'internal' },
  { bindingScope: 'task' },
  { bindingScope: 'tenant' },
  { bindingScope: 'task', lineage: ['charter:abc'] },
];

function decidedEquals(a: AuthorizationDecision, b: AuthorizationDecision): void {
  expect(a).toEqual(b);
}

describe('authorization policy document — coverage', () => {
  const doc = serializeRegistryDocument();
  const entries = declaredAuthorizationEntries();

  it('serializes every declared subject on every axis', () => {
    expect(doc.version).toBe(1);
    const ids = new Set(doc.policies.map((p) => `${p.subject_axis}:${p.subject}`));
    for (const entry of entries) {
      expect(ids.has(`${entry.axis}:${entry.subject}`)).toBe(true);
    }
    expect(doc.policies.length).toBe(entries.length);
  });

  it('emits one default policy per axis, all undeclared fail-safes', () => {
    for (const axis of AXES) {
      const def = doc.defaults[axis];
      expect(def.id).toBe(`default:${axis}`);
      expect(def.provenance.declared).toBe(false);
    }
  });

  it('serializes deterministically', () => {
    expect(serializeRegistryDocument()).toEqual(doc);
  });
});

describe('authorization policy document — meaning preservation', () => {
  const doc = serializeRegistryDocument();

  it('doc evaluation reproduces registry resolution for every declared subject', () => {
    const entries = declaredAuthorizationEntries();
    for (const entry of entries) {
      // Prefix declarations resolve via a synthesized member id.
      const subject = entry.match === 'prefix' ? `${entry.subject}probe` : entry.subject;
      const resolved = subjectAuthorization(subject);
      expect(resolved.declared).toBe(true);
      for (const context of PROBE_CONTEXTS) {
        const viaRegistry = evaluateEntry(resolved, { declared: true }, context);
        const viaDocument = evaluatePolicyDocument(doc, request(subject, context));
        decidedEquals(viaDocument, viaRegistry);
      }
    }
  });

  it('undeclared subjects on every axis evaluate to the axis fail-safe decision', () => {
    const undeclared: readonly string[] = [
      'no:such:op',
      'intent:no-such-intent',
      'capability:no-such-capability',
      'verb:mission:no-such-action',
      // Empty axis-local ids resolve undeclared and must not match anything.
      'intent:',
      'verb:',
    ];
    for (const subject of undeclared) {
      const resolved = subjectAuthorization(subject);
      expect(resolved.declared).toBe(false);
      for (const context of PROBE_CONTEXTS) {
        const viaRegistry = evaluateEntry(resolved, { declared: false }, context);
        const viaDocument = evaluatePolicyDocument(doc, request(subject, context));
        decidedEquals(viaDocument, viaRegistry);
      }
    }
  });

  it('declared fail-safe defaults never carry an approvalDomain', () => {
    // The admission-unify lesson: undeclared authority must not drive routing.
    for (const axis of AXES) {
      const def = doc.defaults[axis];
      if (def.unmet_decision.kind === 'require_approval') {
        expect(def.unmet_decision.approvalDomain).toBeUndefined();
      }
    }
  });
});

describe('authorization policy document — precedence', () => {
  const doc = serializeRegistryDocument();

  it('code declarations outrank data declarations; exact beats prefix', () => {
    // 'email:send' has a code exact entry inside the code 'email:' prefix and
    // the overlay 'service:' family space — the doc must resolve the code
    // exact entry, and document evaluation must equal registry resolution.
    const candidates = doc.policies.filter(
      (p) =>
        p.subject_axis === 'operation' &&
        (p.match === 'exact' ? p.subject === 'email:send' : 'email:send'.startsWith(p.subject))
    );
    expect(candidates.length).toBeGreaterThan(1);
    const winner = evaluatePolicyDocument(doc, request('email:send'));
    const resolved = subjectAuthorization('email:send');
    const viaRegistry = evaluateEntry(resolved, { declared: true }, {});
    expect(winner).toEqual(viaRegistry);
    // The winner's policy is the code exact entry, not a covering prefix.
    const ranked = [...candidates].sort((a, b) => {
      const ra = [
        a.provenance.layer_rank,
        a.match === 'exact' ? 0 : 1,
        -a.subject.length,
        a.provenance.overlay_index,
      ];
      const rb = [
        b.provenance.layer_rank,
        b.match === 'exact' ? 0 : 1,
        -b.subject.length,
        b.provenance.overlay_index,
      ];
      for (let i = 0; i < 4; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    });
    expect(ranked[0].subject).toBe('email:send');
    expect(ranked[0].provenance.layer_rank).toBe(0);
  });

  it('the data layer is flat: plugin exact/longer-prefix beats overlay prefix; provider order breaks ties', () => {
    // Registry semantics: ANY data exact beats every data prefix across all
    // overlays; the longest prefix wins; overlay_index breaks ties. There is
    // no overlay-vs-plugin tier inside the data plane.
    const admission = {
      effectClass: 'external_mutation',
      authority: { kind: 'admission', boundary: 'external' },
    } as const;
    const approval = {
      effectClass: 'external_read',
      authority: { kind: 'approval', assurance: 'A2' },
    } as const;
    const synthetic: AuthorizationOverlay[] = [
      {
        source: 'overlay',
        operations: {},
        prefixes: { 'service:': admission },
      },
      {
        source: 'plugin:test',
        operations: { 'service:exact-op': approval },
        prefixes: { 'service:longer:': approval },
      },
    ];
    const previous = setAuthorizationOverlayProvider(() => synthetic);
    try {
      const doc = serializeRegistryDocument();
      for (const subject of ['service:exact-op', 'service:longer:op', 'service:other']) {
        const resolved = subjectAuthorization(subject);
        for (const context of PROBE_CONTEXTS) {
          expect(evaluatePolicyDocument(doc, request(subject, context))).toEqual(
            evaluateEntry(resolved, { declared: resolved.declared }, context)
          );
        }
      }
      // The plugin exact op must be resolved by the plugin entry, not the
      // overlay 'service:' prefix — the regression the flat-rank fix covers.
      const exact = evaluatePolicyDocument(
        doc,
        request('service:exact-op', { approved: true, assurance: 'A2' })
      );
      expect(exact).toEqual({ kind: 'permit' });
      const longer = evaluatePolicyDocument(
        doc,
        request('service:longer:op', { approved: true, assurance: 'A2' })
      );
      expect(longer).toEqual({ kind: 'permit' });
    } finally {
      setAuthorizationOverlayProvider(previous);
    }
  });
});

describe('authorization policy document — declaration attributes', () => {
  const doc = serializeRegistryDocument();

  it('requires_lineage is emitted iff the declaration is charter-delegable', () => {
    const entries = declaredAuthorizationEntries();
    const byKey = new Map(entries.map((e) => [`${e.axis}:${e.subject}`, e]));
    for (const policy of doc.policies) {
      const decl = byKey.get(`${policy.subject_axis}:${policy.subject}`);
      expect(decl).toBeDefined();
      expect(policy.requires_lineage).toBe(decl!.entry.delegable !== undefined);
    }
  });

  it('degrading credential verbs serialize the degraded-permit unmet path', () => {
    const degrading = doc.policies.filter(
      (p) => p.detail?.kind === 'credential-requirement' && p.detail.requirement === 'degrading'
    );
    expect(degrading.length).toBeGreaterThan(0);
    for (const policy of degrading) {
      expect(policy.unmet_decision).toEqual({ kind: 'permit', degraded: true });
    }
  });

  it('action_class and the delegation contract survive serialization', () => {
    const emailSend = doc.policies.find((p) => p.subject === 'email:send');
    expect(emailSend?.action_class).toBe('send_message_external');
    const vcsPush = doc.policies.find((p) => p.subject === 'vcs:push');
    expect(vcsPush?.delegable).toEqual({
      fields: ['repository', 'branch'],
      optionalFields: ['visibility'],
      reputational_class: 'A',
    });
  });

  it('protected_paths survive serialization', () => {
    const emailSend = doc.policies.find((p) => p.subject === 'email:send');
    expect(emailSend?.protected_paths).toEqual([
      ['params', 'to'],
      ['params', 'cc'],
      ['params', 'from'],
      ['account'],
    ]);
  });
});

describe('authorization policy document — cedar rendering', () => {
  const doc = serializeRegistryDocument();

  it('renders every policy plus the four defaults without throwing', () => {
    const text = cedarDocumentText(doc);
    expect(text.length).toBeGreaterThan(0);
    // Balanced braces and parens across the whole rendering.
    expect(text.split('{').length).toBe(text.split('}').length);
    expect(text.split('(').length).toBe(text.split(')').length);
    // Valid-Cedar invariants: no string >= comparison, no `in` list
    // membership, no glob inside an entity uid.
    expect(text).not.toMatch(/>=\s*"/);
    expect(text).not.toMatch(/\bin\s*\[/);
    expect(text).not.toMatch(/Action::"[^"]*\*/);
    // Prefix declarations bind the subject string via like-matching.
    const prefixPolicy = doc.policies.find((p) => p.match === 'prefix' && p.subject !== '*');
    expect(prefixPolicy).toBeDefined();
    expect(cedarPolicyText(prefixPolicy!)).toContain('context.action_subject like');
    // Fail-safe defaults cannot deny declared requests.
    for (const axis of ['operation', 'intent', 'capability', 'verb'] as const) {
      expect(cedarPolicyText(doc.defaults[axis])).toContain('context.declared == false');
    }
    // One permit statement minimum per policy; ids are unique.
    const ids = doc.policies.map((p) => `@id("${p.id}")`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const policy of doc.policies) {
      const rendered = cedarPolicyText(policy);
      expect(rendered).toContain(`@id("${policy.id}")`);
      expect(rendered).toContain(`@effect_class("${policy.effect_class}")`);
      expect(rendered).toMatch(/\b(permit|forbid)\(/);
    }
  });

  it('renders a known admission op in the pinned Cedar-style form', () => {
    const vcsPush = doc.policies.find((p) => p.subject === 'vcs:push');
    expect(vcsPush).toBeDefined();
    expect(cedarPolicyText(vcsPush!)).toBe(
      [
        '  @id("op:vcs:push")',
        '  @effect_class("external_mutation")',
        '  @requires_lineage',
        '  @source("code")',
        'permit(principal, action == Action::"vcs:push", resource) when { context.admitted == "external" };',
        '  @decision("require_approval")',
        'forbid(principal, action == Action::"vcs:push", resource) unless { context.admitted == "external" };',
      ].join('\n')
    );
  });
});

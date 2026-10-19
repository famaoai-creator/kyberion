import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import {
  isInformationBoundActionClass,
  parseInformationFlowFacts,
} from './accountability-charter.js';
import { acceptCharter, evaluateUnderCharter } from './accountability-charter-registry.js';
import { charterInputForDecision } from './charter-call-site.js';
import {
  envelopeFromForm,
  parseCharterForm,
  renderAcceptanceStatement,
  viewCharter,
} from './charter-service.js';
import { loadCharterDecisionVocabulary } from './charter-decision-vocabulary.js';

const NOW = new Date('2026-10-02T09:00:00.000Z');

const rawForm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant_slug: 'flow-co',
  per_action: 0,
  per_day: 0,
  per_month: 0,
  max_loss_per_incident: 0,
  allow_named_spend: false,
  allow_customer_outbound: false,
  approved_processors: [],
  processing_purposes: [],
  processing_categories: [],
  delegated_decisions: [],
  supersedes_decision_rights: false,
  deputies: [],
  expires_in_days: 90,
  reputational_class_max: 'D',
  ...over,
});

const MEETING_FLOW = {
  purpose: 'meeting_scheduling',
  recipient_class: 'known_counterparty',
  categories: ['routine_business'],
  attachment_count: 0,
};

describe('charter form — recipient delegation', () => {
  it('accepts a complete recipient scope and rejects a partial one', () => {
    const ok = parseCharterForm(
      rawForm({
        recipient_purposes: ['meeting_scheduling'],
        recipient_classes: ['known_counterparty'],
        recipient_categories: ['routine_business'],
      })
    );
    expect(ok.ok && ok.form.recipient_classes).toEqual(['known_counterparty']);
    expect(ok.ok && ok.form.max_attachments).toBe(0);

    for (const partial of [
      { recipient_purposes: ['meeting_scheduling'] },
      { recipient_classes: ['known_counterparty'] },
      { recipient_categories: ['routine_business'] },
    ]) {
      expect(parseCharterForm(rawForm(partial)).ok).toBe(false);
    }
    expect(
      parseCharterForm(
        rawForm({
          recipient_purposes: ['meeting_scheduling'],
          recipient_classes: ['known_counterparty'],
          recipient_categories: ['routine_business'],
          max_attachments: 21,
        })
      ).ok
    ).toBe(false);
    expect(parseCharterForm(rawForm({ max_attachments: 1 })).ok).toBe(false);
    expect(
      parseCharterForm(
        rawForm({
          recipient_purposes: ['meeting_scheduling'],
          recipient_classes: ['everyone'],
          recipient_categories: ['routine_business'],
        })
      ).ok
    ).toBe(false);
  });

  it('unions the greeting scope with the explicit recipient scope in the envelope and the signed statement', () => {
    const parsed = parseCharterForm(
      rawForm({
        allow_customer_outbound: true,
        delegated_decisions: ['meeting_scheduling'],
        recipient_purposes: ['meeting_scheduling'],
        recipient_classes: ['known_counterparty'],
        recipient_categories: ['routine_business'],
      })
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const envelope = envelopeFromForm(parsed.form);
    expect(envelope.information_flow).toMatchObject({
      purposes: ['customer_service', 'meeting_scheduling'],
      recipient_classes: ['bound_customer', 'known_counterparty'],
      categories: ['routine_business'],
      max_attachments: 0,
    });
    expect(envelope.external_effects.send_message_external).toBe('allow');
    expect(envelope.irreversible_named_actions).toEqual(
      expect.arrayContaining(['customer_outbound', 'meeting_scheduling'])
    );

    const statement = renderAcceptanceStatement({
      form: parsed.form,
      accountableId: 'user:owner',
      displayName: 'Owner',
      now: NOW,
    });
    expect(statement).toContain('purposes customer_service, meeting_scheduling');
    expect(statement).toContain('recipients bound_customer, known_counterparty');
    expect(statement).toContain('New recipients');
  });

  it('states that external recipient automation is off when nothing was delegated', () => {
    const parsed = parseCharterForm(rawForm());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(
      renderAcceptanceStatement({
        form: parsed.form,
        accountableId: 'user:owner',
        displayName: 'Owner',
        now: NOW,
      })
    ).toContain('External recipient automation is disabled');
  });
});

describe('facts at the decision-rights entry point', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-flow-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    acceptCharter(
      {
        draft: {
          charter_id: 'chr-flow-co-1',
          scope: { kind: 'organization', tenant_slug: 'flow-co' },
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
            expires_at: '2026-12-31T00:00:00.000Z',
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: {
              send_message_external: 'allow',
              publish_public: 'allow',
            },
            irreversible: 'named_actions_only',
            irreversible_named_actions: [
              'meeting_scheduling',
              'external_reply',
              'public_announcement',
            ],
            delegated_decisions: {
              meeting_scheduling: 'allow',
              external_reply: 'allow',
              public_announcement: 'allow',
            },
            information_flow: {
              purposes: ['meeting_scheduling'],
              recipient_classes: ['known_counterparty'],
              categories: ['routine_business'],
              max_attachments: 0,
            },
          },
          appetite: {
            max_loss_per_incident: 0,
            reputational_class_max: 'D',
            blast_radius_max: { recipients: 1, systems: 1 },
            tripwires: [],
          },
        },
        statement: 'I am accountable.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: NOW,
      },
      opts()
    );
  });

  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });

  const evaluate = (informationFlow?: unknown) => {
    const charter = charterInputForDecision(
      {
        tenantSlug: 'flow-co',
        decisionType: 'meeting_scheduling',
        ...(informationFlow !== undefined ? { informationFlow } : {}),
      },
      opts(),
      NOW
    );
    if (!charter) throw new Error('expected an active charter');
    return evaluateUnderCharter(
      charter.scope,
      charter.action,
      { accountable_available: true, available_deputies: [] },
      opts(),
      NOW
    )!.decision;
  };

  it('allows a delegated meeting only with matching recipient facts', () => {
    const decision = evaluate(MEETING_FLOW);
    expect(decision.decision).toBe('allow');
  });

  it('denies an information-bound action that carries no facts', () => {
    const decision = evaluate();
    expect(decision.decision).toBe('deny');
    expect(decision.reasons).toContain(
      'information_flow facts are required for external recipient actions'
    );
  });

  it('denies a purpose, recipient class, category or attachment the charter did not delegate', () => {
    expect(evaluate({ ...MEETING_FLOW, purpose: 'external_reply' }).reasons.join(' ')).toContain(
      "purpose 'external_reply' not delegated"
    );
    expect(evaluate({ ...MEETING_FLOW, recipient_class: 'public' }).reasons.join(' ')).toContain(
      "recipient 'public' not delegated"
    );
    expect(
      evaluate({ ...MEETING_FLOW, categories: ['sensitive_business'] }).reasons.join(' ')
    ).toContain('categories not delegated');
    expect(evaluate({ ...MEETING_FLOW, attachment_count: 1 }).reasons.join(' ')).toContain(
      'attachment limit exceeded'
    );
  });

  it('rejects processor facts on an external recipient action', () => {
    const { recipient_class: _ignored, ...withoutRecipient } = MEETING_FLOW;
    const decision = evaluate({ ...withoutRecipient, processor_id: 'anthropic' });
    expect(decision.decision).toBe('deny');
    expect(decision.reasons).toContain(
      'external recipient actions require recipient facts, not processor facts'
    );
  });

  it('treats malformed facts as an input error, never as "no facts"', () => {
    for (const bad of [
      { ...MEETING_FLOW, categories: [] },
      { ...MEETING_FLOW, purpose: 'Not A Purpose' },
      { ...MEETING_FLOW, recipient_class: 'everyone' },
      { purpose: 'meeting_scheduling', categories: ['routine_business'] },
      { ...MEETING_FLOW, attachment_count: -1 },
    ]) {
      expect(() => evaluate(bad)).toThrow(/information_flow/);
    }
  });

  it('parses facts with a default attachment count and de-duplicated categories', () => {
    const parsed = parseInformationFlowFacts({
      purpose: 'customer_service',
      recipient_class: 'bound_customer',
      categories: ['routine_business', 'routine_business'],
    });
    expect(parsed).toEqual({
      ok: true,
      facts: {
        purpose: 'customer_service',
        recipient_class: 'bound_customer',
        categories: ['routine_business'],
        attachment_count: 0,
      },
    });
  });

  it('covers every information-bound vocabulary entry: none invents recipient facts', () => {
    const vocabulary = loadCharterDecisionVocabulary();
    const entries = vocabulary.decisions.filter((entry) =>
      isInformationBoundActionClass(entry.action_class)
    );
    expect(entries.map((entry) => entry.decision_type).sort()).toEqual([
      'external_reply',
      'meeting_scheduling',
      'public_announcement',
    ]);
    for (const entry of entries) {
      const charter = charterInputForDecision(
        { tenantSlug: 'flow-co', decisionType: entry.decision_type },
        opts(),
        NOW
      );
      expect(charter?.action.information_flow).toBeUndefined();
    }
  });

  it('view exposes the recipient scope for the form to carry forward', () => {
    const c = charterInputForDecision(
      { tenantSlug: 'flow-co', decisionType: 'meeting_scheduling', informationFlow: MEETING_FLOW },
      opts(),
      NOW
    )!;
    const evaluated = evaluateUnderCharter(
      c.scope,
      c.action,
      { accountable_available: true, available_deputies: [] },
      opts(),
      NOW
    )!;
    const view = viewCharter(evaluated.charter, NOW, opts());
    expect(view.recipient_purposes).toEqual(['meeting_scheduling']);
    expect(view.recipient_classes).toEqual(['known_counterparty']);
    expect(view.recipient_categories).toEqual(['routine_business']);
    expect(view.max_attachments).toBe(0);
  });
});

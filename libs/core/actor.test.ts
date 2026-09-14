import { describe, expect, it } from 'vitest';
import {
  ActorAccountabilityError,
  ActorFormatError,
  actorFromLegacy,
  actorId,
  agentActor,
  assertHumanActor,
  humanActor,
  parseActorRef,
  serviceActor,
} from './actor.js';

const VALID_NHI_ID = 'kyberion://agent/default/report-writer';

describe('actor vocabulary (FD-10)', () => {
  describe('humanActor', () => {
    it('builds a user:<member_id> actor', () => {
      expect(humanActor('owner')).toEqual({ kind: 'human', id: 'user:owner' });
    });

    it('carries an optional display name', () => {
      expect(humanActor('owner', 'Owner')).toEqual({
        kind: 'human',
        id: 'user:owner',
        display_name: 'Owner',
      });
    });

    it('rejects a grammar-invalid member id', () => {
      expect(() => humanActor('Not Valid!')).toThrow(ActorFormatError);
      expect(() => humanActor('')).toThrow(ActorFormatError);
    });
  });

  describe('agentActor', () => {
    it('builds an nhi_id actor', () => {
      expect(agentActor(VALID_NHI_ID)).toEqual({ kind: 'agent', id: VALID_NHI_ID });
    });

    it('carries an optional on_behalf_of human actor id', () => {
      expect(agentActor(VALID_NHI_ID, 'user:owner')).toEqual({
        kind: 'agent',
        id: VALID_NHI_ID,
        on_behalf_of: 'user:owner',
      });
    });

    it('rejects a grammar-invalid nhi_id', () => {
      expect(() => agentActor('not-an-nhi-id')).toThrow(ActorFormatError);
    });

    it('rejects an invalid on_behalf_of human id', () => {
      expect(() => agentActor(VALID_NHI_ID, 'human:operator')).toThrow(ActorFormatError);
    });
  });

  describe('serviceActor', () => {
    it('builds a service:<slug> actor from a bare slug', () => {
      expect(serviceActor('stripe')).toEqual({ kind: 'service', id: 'service:stripe' });
    });

    it('accepts an already-prefixed id idempotently', () => {
      expect(serviceActor('service:stripe')).toEqual({ kind: 'service', id: 'service:stripe' });
    });

    it('rejects a grammar-invalid slug', () => {
      expect(() => serviceActor('Not Valid')).toThrow(ActorFormatError);
    });
  });

  describe('parseActorRef', () => {
    it('round-trips a valid human actor', () => {
      const actor = humanActor('owner', 'Owner');
      expect(parseActorRef(actor)).toEqual(actor);
    });

    it('round-trips a valid agent actor', () => {
      const actor = agentActor(VALID_NHI_ID, 'user:owner');
      expect(parseActorRef(actor)).toEqual(actor);
    });

    it('round-trips a valid service actor', () => {
      const actor = serviceActor('stripe');
      expect(parseActorRef(actor)).toEqual(actor);
    });

    it('drops unknown extra properties (additive-tolerant)', () => {
      expect(parseActorRef({ kind: 'human', id: 'user:owner', future_field: 'x' })).toEqual({
        kind: 'human',
        id: 'user:owner',
      });
    });

    it.each([
      ['not an object', 'user:owner'],
      ['null', null],
      ['missing id', { kind: 'human' }],
      ['unknown kind', { kind: 'robot', id: 'user:owner' }],
      ['human id without user: prefix', { kind: 'human', id: 'owner' }],
      ['human id with invalid member grammar', { kind: 'human', id: 'user:Not Valid!' }],
      ['agent id that is not a valid nhi_id', { kind: 'agent', id: 'not-an-nhi-id' }],
      ['service id without service: prefix', { kind: 'service', id: 'stripe' }],
      ['service id with invalid slug', { kind: 'service', id: 'service:Not Valid' }],
    ])('returns null for %s', (_label, value) => {
      expect(parseActorRef(value)).toBeNull();
    });
  });

  describe('actorId', () => {
    it('returns the actor id', () => {
      expect(actorId(humanActor('owner'))).toBe('user:owner');
    });
  });

  describe('assertHumanActor', () => {
    it('passes for a human actor', () => {
      expect(() => assertHumanActor(humanActor('owner'), 'decide')).not.toThrow();
    });

    it('throws for a non-human actor', () => {
      expect(() => assertHumanActor(agentActor(VALID_NHI_ID), 'decide')).toThrow(
        ActorAccountabilityError
      );
    });

    it('throws when no actor is given', () => {
      expect(() => assertHumanActor(undefined, 'decide')).toThrow(ActorAccountabilityError);
    });
  });

  describe('actorFromLegacy', () => {
    it('returns undefined for an empty/undefined value', () => {
      expect(actorFromLegacy(undefined)).toBeUndefined();
      expect(actorFromLegacy('')).toBeUndefined();
      expect(actorFromLegacy('   ')).toBeUndefined();
    });

    it('maps a user:<id> string to a human actor', () => {
      expect(actorFromLegacy('user:owner')).toEqual({ kind: 'human', id: 'user:owner' });
    });

    it('does not treat an invalid user:<id> string as a verified human', () => {
      expect(actorFromLegacy('user:not valid')).toEqual({
        kind: 'service',
        id: 'user:not valid',
      });
    });

    it('maps a canonical nhi_id string to an agent actor', () => {
      expect(actorFromLegacy(VALID_NHI_ID)).toEqual({ kind: 'agent', id: VALID_NHI_ID });
    });

    it('maps legacy synthetic labels (e.g. human:operator) to a service actor, never human', () => {
      expect(actorFromLegacy('human:operator')).toEqual({
        kind: 'service',
        id: 'human:operator',
      });
    });

    it('maps other free-string labels to a service actor with the raw id', () => {
      expect(actorFromLegacy('orchestrator')).toEqual({ kind: 'service', id: 'orchestrator' });
      expect(actorFromLegacy('concierge')).toEqual({ kind: 'service', id: 'concierge' });
    });
  });
});

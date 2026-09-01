import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  CAPABILITY_TIER_PRIVILEGE,
  DelegationAttenuationError,
  appendDelegationLink,
  assertChainAttenuation,
  buildDelegationLink,
  delegationChainRootActor,
  embedDelegationChainInContext,
  extractDelegationChainFromContext,
  parseDelegationChain,
  serializeDelegationChain,
  validateChainAttenuation,
  type DelegationChain,
} from './delegation-chain.js';
import { SUBAGENT_CAPABILITY_PROFILES } from './subagent-capability-profiles.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

function link(
  actor: string,
  scope: Parameters<typeof buildDelegationLink>[0]['granted_scope'] = {},
  teamRole?: string
) {
  return buildDelegationLink({
    actor,
    granted_scope: scope,
    ...(teamRole ? { team_role: teamRole } : {}),
    granted_at: '2026-07-26T00:00:00.000Z',
  });
}

describe('delegation-chain (NI-03)', () => {
  describe('model + construction', () => {
    it('appendDelegationLink never mutates the input chain', () => {
      const root: DelegationChain = [link('user:founder')];
      const extended = appendDelegationLink(root, link('kyberion://agent/org-a/worker'));
      expect(root).toHaveLength(1);
      expect(extended).toHaveLength(2);
      expect(extended[0]).toEqual(root[0]);
      // Deep-copied granted_scope: mutating the appended link's source scope
      // does not reach into the chain.
      const scope = { capabilities: ['file:read'] };
      const source = link('kyberion://agent/org-a/sub', scope);
      const chain = appendDelegationLink(extended, source);
      source.granted_scope.capabilities!.push('file:write');
      expect(chain[2].granted_scope.capabilities).toEqual(['file:read']);
    });

    it('chains are root-first: delegationChainRootActor is the originating principal', () => {
      const chain = appendDelegationLink([link('user:founder')], link('kyberion://agent/o/w'));
      expect(delegationChainRootActor(chain)).toBe('user:founder');
      expect(delegationChainRootActor([])).toBeUndefined();
    });

    it('buildDelegationLink rejects an empty actor', () => {
      expect(() => buildDelegationLink({ actor: '  ' })).toThrow(/non-empty actor/);
    });
  });

  describe('CAPABILITY_TIER_PRIVILEGE encodes the KD-05 registry privilege order', () => {
    it('matches the actual allowedOps evidence in SUBAGENT_CAPABILITY_PROFILES', () => {
      const byName = new Map(SUBAGENT_CAPABILITY_PROFILES.map((p) => [p.name, p]));
      // implementer: allowedOps '*' — full read/write/exec → most privileged.
      expect(byName.get('implementer')?.allowedOps).toBe('*');
      // planner: no ops at all → least privileged.
      expect(byName.get('planner')?.allowedOps).toEqual([]);
      // explorer: a finite read-only list → strictly between the two.
      const explorerOps = byName.get('explorer')?.allowedOps;
      expect(Array.isArray(explorerOps) && explorerOps.length > 0).toBe(true);
      expect(
        CAPABILITY_TIER_PRIVILEGE.implementer > CAPABILITY_TIER_PRIVILEGE.explorer &&
          CAPABILITY_TIER_PRIVILEGE.explorer > CAPABILITY_TIER_PRIVILEGE.planner
      ).toBe(true);
      // Registration-ceremony guard: every registered tier has a privilege rank.
      for (const profile of SUBAGENT_CAPABILITY_PROFILES) {
        expect(CAPABILITY_TIER_PRIVILEGE).toHaveProperty(profile.name);
      }
    });
  });

  describe('attenuation validation (child ⊆ parent, fail-closed)', () => {
    it('absent parent fields are unrestricted: any child grant is allowed under them', () => {
      const chain = appendDelegationLink(
        [link('user:founder')],
        link('kyberion://agent/o/w', {
          capability_tier: 'implementer',
          capabilities: ['file:write'],
          write_scopes: ['active/missions/**'],
        })
      );
      expect(validateChainAttenuation(chain)).toEqual({ ok: true, violations: [] });
    });

    it('allows equal or downward tier steps; rejects a child tier that outranks its parent', () => {
      const equal = [
        link('a', { capability_tier: 'explorer' }),
        link('b', { capability_tier: 'explorer' }),
      ];
      expect(validateChainAttenuation(equal).ok).toBe(true);

      const downward = [
        link('a', { capability_tier: 'explorer' }),
        link('b', { capability_tier: 'planner' }),
      ];
      expect(validateChainAttenuation(downward).ok).toBe(true);

      const escalating = [
        link('a', { capability_tier: 'explorer' }),
        link('b', { capability_tier: 'implementer' }),
      ];
      const result = validateChainAttenuation(escalating);
      expect(result.ok).toBe(false);
      expect(result.violations[0]).toMatch(/outranks the parent grant "explorer"/);
    });

    it('a child that omits a dimension the parent restricted is a violation (absence = unrestricted)', () => {
      const tierOmitted = [link('a', { capability_tier: 'explorer' }), link('b', {})];
      expect(validateChainAttenuation(tierOmitted).ok).toBe(false);

      const capsOmitted = [link('a', { capabilities: ['file:read'] }), link('b', {})];
      expect(validateChainAttenuation(capsOmitted).ok).toBe(false);

      const scopesOmitted = [link('a', { write_scopes: ['x/**'] }), link('b', {})];
      expect(validateChainAttenuation(scopesOmitted).ok).toBe(false);
    });

    it('capabilities / write_scopes must be subsets of the parent grant', () => {
      const ok = [
        link('a', { capabilities: ['file:read', 'file:list'], write_scopes: ['m/**', 'n/**'] }),
        link('b', { capabilities: ['file:read'], write_scopes: ['n/**'] }),
      ];
      expect(validateChainAttenuation(ok).ok).toBe(true);

      const superset = [
        link('a', { capabilities: ['file:read'] }),
        link('b', { capabilities: ['file:read', 'file:write'] }),
      ];
      const result = validateChainAttenuation(superset);
      expect(result.ok).toBe(false);
      expect(result.violations[0]).toContain('file:write');
    });

    it('unknown tier names cannot prove attenuation → violation', () => {
      const chain = [
        link('a', { capability_tier: 'implementer' }),
        { ...link('b'), granted_scope: { capability_tier: 'superuser' as never } },
      ];
      expect(validateChainAttenuation(chain).ok).toBe(false);
    });

    it('assertChainAttenuation throws the typed DelegationAttenuationError carrying the violations', () => {
      const escalating = [
        link('a', { capability_tier: 'planner' }),
        link('b', { capability_tier: 'explorer' }),
      ];
      try {
        assertChainAttenuation(escalating);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DelegationAttenuationError);
        expect((error as DelegationAttenuationError).violations).toHaveLength(1);
        expect((error as DelegationAttenuationError).name).toBe('DelegationAttenuationError');
      }
    });
  });

  describe('serialization (audit reconstruction round-trip)', () => {
    it('serialize → parse → serialize is lossless for a full 3-hop chain', () => {
      const chain = [
        link('user:founder', {}, 'owner'),
        link('kyberion://agent/o/orchestrator', { capability_tier: 'implementer' }, 'orchestrator'),
        link(
          'kyberion://agent/o/worker',
          { capability_tier: 'explorer', capabilities: ['file:read'] },
          'reviewer'
        ),
      ];
      const serialized = serializeDelegationChain(chain);
      const parsed = parseDelegationChain(serialized);
      expect(parsed).toEqual(chain);
      expect(serializeDelegationChain(parsed!)).toBe(serialized);
      // Structured (already-parsed JSON) input parses too — the ledger path.
      expect(parseDelegationChain(JSON.parse(serialized))).toEqual(chain);
    });

    it('rejects malformed inputs (never throws)', () => {
      expect(parseDelegationChain('{not json[')).toBeNull();
      expect(
        parseDelegationChain(
          '[{"actor":"a","granted_scope":{"capabilities":["file:read"],"meta":{"__proto__":{}}},"granted_at":"t"}]'
        )
      ).toBeNull(); // dangerous nested JSON key
      expect(parseDelegationChain({ actor: 'x' })).toBeNull(); // not an array
      expect(parseDelegationChain([{ granted_scope: {}, granted_at: 'now' }])).toBeNull(); // no actor
      expect(parseDelegationChain([{ actor: 'a', granted_scope: {} }])).toBeNull(); // no granted_at
      expect(
        parseDelegationChain([
          { actor: 'a', granted_scope: { capability_tier: 'superuser' }, granted_at: 't' },
        ])
      ).toBeNull(); // unknown tier
      expect(
        parseDelegationChain([
          { actor: 'a', granted_scope: { capabilities: [1] }, granted_at: 't' },
        ])
      ).toBeNull(); // non-string capability
      expect(parseDelegationChain([])).toEqual([]); // empty chain is valid
    });
  });

  describe('context-string embedding (agent-dispatch seam)', () => {
    it('embeds into and extracts from a context string, stripping the block', () => {
      const chain = [
        link('user:founder'),
        link('kyberion://agent/o/w', { capability_tier: 'explorer' }),
      ];
      const embedded = embedDelegationChainInContext('mission context here', chain);
      const extracted = extractDelegationChainFromContext(embedded);
      expect(extracted.chain).toEqual(chain);
      expect(extracted.malformed).toBe(false);
      expect(extracted.contextWithoutChain).toBe('mission context here');
    });

    it('embeds into an undefined context and extracts back to undefined', () => {
      const chain = [link('user:founder')];
      const embedded = embedDelegationChainInContext(undefined, chain);
      const extracted = extractDelegationChainFromContext(embedded);
      expect(extracted.chain).toEqual(chain);
      expect(extracted.contextWithoutChain).toBeUndefined();
    });

    it('flags a malformed embedded block; chain-less contexts pass through untouched', () => {
      const malformed = extractDelegationChainFromContext(
        'ctx\n<delegation-chain>{broken</delegation-chain>'
      );
      expect(malformed.chain).toBeNull();
      expect(malformed.malformed).toBe(true);

      const plain = extractDelegationChainFromContext('just a normal context');
      expect(plain).toEqual({
        chain: null,
        malformed: false,
        contextWithoutChain: 'just a normal context',
      });
    });
  });

  describe('task-contract.schema.json delegation_chain (additive)', () => {
    const baseContract = {
      task_id: 'task-1',
      mission_id: 'MSN-NI03',
      owner_agent_id: 'orchestrator',
      status: 'planned',
      requested_role: 'worker',
      objective: 'do the thing',
    };

    function compile() {
      const ajv = new Ajv({ allErrors: true });
      return compileSchemaFromPath(
        ajv,
        path.resolve(process.cwd(), 'knowledge/product/schemas/task-contract.schema.json')
      );
    }

    it('accepts a chain-less contract (unchanged) and a valid delegation_chain', () => {
      const validate = compile();
      expect(validate(baseContract), JSON.stringify(validate.errors || [])).toBe(true);
      expect(
        validate({
          ...baseContract,
          delegation_chain: [
            {
              actor: 'kyberion://agent/o/orchestrator',
              team_role: 'orchestrator',
              granted_scope: {},
              granted_at: '2026-07-26T00:00:00.000Z',
            },
            {
              actor: 'kyberion://agent/o/worker',
              granted_scope: { capability_tier: 'implementer', capabilities: ['file:write'] },
              granted_at: '2026-07-26T00:00:01.000Z',
            },
          ],
        }),
        JSON.stringify(validate.errors || [])
      ).toBe(true);
    });

    it('rejects links with unknown tiers, missing required fields, or extra scope keys', () => {
      const validate = compile();
      expect(
        validate({
          ...baseContract,
          delegation_chain: [
            { actor: 'a', granted_scope: { capability_tier: 'superuser' }, granted_at: 't' },
          ],
        })
      ).toBe(false);
      expect(
        validate({ ...baseContract, delegation_chain: [{ actor: 'a', granted_scope: {} }] })
      ).toBe(false);
      expect(
        validate({
          ...baseContract,
          delegation_chain: [{ actor: 'a', granted_scope: { sudo: true }, granted_at: 't' }],
        })
      ).toBe(false);
    });
  });
});

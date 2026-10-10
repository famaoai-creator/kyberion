import { describe, expect, it } from 'vitest';
import {
  applyScimPatch,
  isScimProvisioningTokenFormat,
  parseScimFilter,
  parseScimPaging,
  parseScimUserInput,
  scimDisplayName,
  scimErrorBody,
  scimFilterMatches,
  ScimError,
  SCIM_ERROR_SCHEMA,
  SCIM_MAX_RESULTS,
  SCIM_PATCH_OP_SCHEMA,
  SCIM_USER_SCHEMA,
  type ScimUserAttributes,
} from './scim-protocol.js';

const scimFailure = (fn: () => unknown, status: number, scimType?: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScimError);
    expect((error as ScimError).status).toBe(status);
    if (scimType) expect((error as ScimError).scimType).toBe(scimType);
    return;
  }
  throw new Error(`expected ScimError(${status})`);
};

const base: ScimUserAttributes = {
  userName: 'alice@example.com',
  externalId: 'ext-1',
  displayName: 'Alice',
  emails: [{ value: 'alice@example.com', type: 'work', primary: true }],
  active: true,
};
const patch = (...Operations: unknown[]) => ({ schemas: [SCIM_PATCH_OP_SCHEMA], Operations });

describe('scim protocol — error envelope and token shape', () => {
  it('builds the RFC 7644 §3.12 error body', () => {
    expect(scimErrorBody(409, 'taken', 'uniqueness')).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      status: '409',
      detail: 'taken',
      scimType: 'uniqueness',
    });
    expect(scimErrorBody(404, 'missing')).not.toHaveProperty('scimType');
  });

  it('recognises only the kscim~ token shape', () => {
    expect(isScimProvisioningTokenFormat('kscim~acme~scim-0123456789abcdef~secret')).toBe(true);
    expect(isScimProvisioningTokenFormat(' kscim~x')).toBe(true);
    expect(isScimProvisioningTokenFormat('a'.repeat(64))).toBe(false);
    expect(isScimProvisioningTokenFormat(null)).toBe(false);
  });
});

describe('scim protocol — user input mapping', () => {
  it('keeps the core subset, ignores read-only/unknown attributes, defaults active', () => {
    const user = parseScimUserInput({
      schemas: [SCIM_USER_SCHEMA],
      id: 'ignored',
      meta: { created: 'x' },
      userName: '  alice@example.com ',
      externalId: 'ext-1',
      name: { givenName: 'Alice', familyName: 'Smith', middleName: 'ignored' },
      emails: [{ value: 'alice@example.com', type: 'work', primary: true }],
      roles: [{ value: 'owner' }],
    });
    expect(user).toEqual({
      userName: 'alice@example.com',
      externalId: 'ext-1',
      name: { givenName: 'Alice', familyName: 'Smith' },
      emails: [{ value: 'alice@example.com', type: 'work', primary: true }],
      active: true,
    });
    expect(scimDisplayName(user)).toBe('Alice Smith');
    expect(scimDisplayName({ userName: 'bob', active: true })).toBe('bob');
  });

  it('rejects missing userName, wrong schemas, bad emails and control characters', () => {
    scimFailure(() => parseScimUserInput({ schemas: [SCIM_USER_SCHEMA] }), 400, 'invalidValue');
    scimFailure(
      () => parseScimUserInput({ schemas: ['urn:x'], userName: 'a' }),
      400,
      'invalidSyntax'
    );
    scimFailure(() => parseScimUserInput([]), 400, 'invalidSyntax');
    scimFailure(() => parseScimUserInput({ userName: 'a', emails: [{ value: 'no-at' }] }), 400);
    scimFailure(() => parseScimUserInput({ userName: 'a\u0000b' }), 400);
    scimFailure(() => parseScimUserInput({ userName: 'a', active: 'maybe' }), 400);
  });
});

describe('scim protocol — filter and paging', () => {
  it('parses userName / externalId eq filters case-insensitively, with escapes', () => {
    expect(parseScimFilter('userName eq "alice@example.com"')).toEqual({
      attribute: 'userName',
      value: 'alice@example.com',
    });
    expect(parseScimFilter('EXTERNALID EQ "a\\"b"')).toEqual({
      attribute: 'externalId',
      value: 'a"b',
    });
    expect(parseScimFilter(undefined)).toBeNull();
    expect(parseScimFilter('  ')).toBeNull();
  });

  it('rejects every other filter rather than returning an unfiltered list', () => {
    for (const filter of [
      'userName co "a"',
      'emails.value eq "a@b"',
      'userName eq "a" or userName eq "b"',
      'userName eq a',
      'displayName eq "x"',
    ]) {
      scimFailure(() => parseScimFilter(filter), 400, 'invalidFilter');
    }
  });

  it('matches userName case-insensitively and externalId exactly', () => {
    expect(scimFilterMatches({ attribute: 'userName', value: 'ALICE@example.com' }, base)).toBe(
      true
    );
    expect(scimFilterMatches({ attribute: 'externalId', value: 'EXT-1' }, base)).toBe(false);
    expect(scimFilterMatches({ attribute: 'externalId', value: 'ext-1' }, base)).toBe(true);
  });

  it('clamps startIndex/count per RFC 7644 §3.4.2.4', () => {
    expect(parseScimPaging(null, null)).toEqual({ startIndex: 1, count: 100 });
    expect(parseScimPaging('0', '-5')).toEqual({ startIndex: 1, count: 0 });
    expect(parseScimPaging('3', '100000')).toEqual({ startIndex: 3, count: SCIM_MAX_RESULTS });
    scimFailure(() => parseScimPaging('abc', null), 400, 'invalidValue');
  });
});

describe('scim protocol — PatchOp', () => {
  it('applies the Entra ID shape (capitalised op, "False" string, emails[type eq].value)', () => {
    const next = applyScimPatch(
      base,
      patch(
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'Replace', path: 'displayName', value: 'Alice S.' },
        { op: 'Add', path: 'emails[type eq "work"].value', value: 'alice.s@example.com' },
        { op: 'Replace', path: 'name.givenName', value: 'Alicia' },
        { op: 'Replace', path: `${SCIM_USER_SCHEMA}:userName`, value: 'alicia@example.com' }
      )
    );
    expect(next).toMatchObject({
      active: false,
      displayName: 'Alice S.',
      userName: 'alicia@example.com',
      name: { givenName: 'Alicia' },
      emails: [{ value: 'alice.s@example.com', type: 'work', primary: true }],
    });
  });

  it('applies the Okta shape (path-less replace with an object value)', () => {
    const next = applyScimPatch(base, patch({ op: 'replace', value: { active: false, id: 'x' } }));
    expect(next.active).toBe(false);
    expect(next.userName).toBe(base.userName);
  });

  it('removes optional attributes and refuses removing required ones', () => {
    const next = applyScimPatch(
      base,
      patch({ op: 'remove', path: 'externalId' }, { op: 'remove', path: 'emails[type eq "work"]' })
    );
    expect(next).not.toHaveProperty('externalId');
    expect(next).not.toHaveProperty('emails');
    scimFailure(
      () => applyScimPatch(base, patch({ op: 'remove', path: 'userName' })),
      400,
      'mutability'
    );
    scimFailure(
      () => applyScimPatch(base, patch({ op: 'remove', path: 'active' })),
      400,
      'mutability'
    );
    scimFailure(() => applyScimPatch(base, patch({ op: 'remove' })), 400, 'noTarget');
  });

  it('ignores unstored core attributes and extension schemas (Entra ID default mapping)', () => {
    const next = applyScimPatch(
      base,
      patch(
        { op: 'Add', path: 'title', value: 'Engineer' },
        { op: 'Add', path: 'preferredLanguage', value: 'ja-JP' },
        { op: 'Add', path: 'phoneNumbers[type eq "work"].value', value: '+81-3-0000-0000' },
        { op: 'Add', path: 'addresses[type eq "work"].locality', value: 'Tokyo' },
        {
          op: 'Add',
          path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
          value: 'R&D',
        },
        { op: 'Replace', path: 'displayName', value: 'Alice 2' }
      )
    );
    expect(next).toEqual({ ...base, displayName: 'Alice 2' });
    scimFailure(
      () => applyScimPatch(base, patch({ op: 'add', path: 'unknownAttr', value: 1 })),
      400,
      'invalidPath'
    );
  });

  it('never accepts role or group paths (roles are decided in Kyberion)', () => {
    for (const path of ['roles', 'groups', 'entitlements', 'members']) {
      scimFailure(
        () => applyScimPatch(base, patch({ op: 'replace', path, value: [{ value: 'owner' }] })),
        400,
        'invalidPath'
      );
    }
    scimFailure(
      () => applyScimPatch(base, patch({ op: 'replace', value: { roles: [{ value: 'owner' }] } })),
      400,
      'invalidPath'
    );
    // Case and core-schema URN variants resolve to the same refused attribute.
    for (const path of [
      'Roles',
      'ROLES',
      'roles[primary eq true].value',
      `${SCIM_USER_SCHEMA}:roles`,
      `${SCIM_USER_SCHEMA.toUpperCase()}:Roles`,
      `${SCIM_USER_SCHEMA}:groups`,
    ]) {
      scimFailure(
        () => applyScimPatch(base, patch({ op: 'Add', path, value: [{ value: 'owner' }] })),
        400,
        'invalidPath'
      );
      scimFailure(
        () => applyScimPatch(base, patch({ op: 'replace', value: { [path]: 'owner' } })),
        400,
        'invalidPath'
      );
    }
  });

  it('refuses prototype keys in a path-less PATCH without polluting anything', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const value = JSON.parse(`{"${key}": {"active": false, "polluted": true}}`) as unknown;
      scimFailure(() => applyScimPatch(base, patch({ op: 'replace', value })), 400, 'invalidPath');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(base.active).toBe(true);
  });

  it('rejects malformed PatchOp envelopes', () => {
    scimFailure(() => applyScimPatch(base, { Operations: [] }), 400, 'invalidSyntax');
    scimFailure(() => applyScimPatch(base, patch()), 400, 'invalidSyntax');
    scimFailure(
      () => applyScimPatch(base, patch({ op: 'move', path: 'active' })),
      400,
      'invalidSyntax'
    );
    scimFailure(
      () =>
        applyScimPatch(
          base,
          patch(
            ...Array.from({ length: 51 }, () => ({ op: 'add', path: 'displayName', value: 'x' }))
          )
        ),
      400,
      'tooMany'
    );
  });
});

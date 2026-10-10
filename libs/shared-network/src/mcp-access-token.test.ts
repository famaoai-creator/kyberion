import { constants, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  createMcpAccessTokenVerifier,
  type McpAccessTokenAlgorithm,
  type McpAccessTokenVerifierConfig,
  type McpPublicJsonWebKey,
} from './mcp-access-token.js';

// All keys and claims are synthetic; no provider, secret, filesystem, or network.
const RSA = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const OTHER_RSA = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const EC = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ISSUER = 'https://issuer.example/tenant';
const RESOURCE = 'https://resource.example/mcp';
const NOW = 1_800_000_000;
const RSA_JWK = { ...RSA.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256' };
const EC_JWK = { ...EC.publicKey.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256' };

function configuration(
  overrides: Partial<McpAccessTokenVerifierConfig> = {}
): McpAccessTokenVerifierConfig {
  return {
    issuer: ISSUER,
    resource: RESOURCE,
    algorithms: ['RS256', 'ES256'],
    jwks: { keys: [RSA_JWK, EC_JWK] },
    nowSeconds: () => NOW,
    ...overrides,
  };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: RESOURCE,
    sub: 'subject-1',
    client_id: 'client-1',
    jti: 'jti-1',
    iat: NOW - 60,
    exp: NOW + 60,
    scope: 'requests:read requests:submit',
    ...overrides,
  };
}

function signParts(
  headerPart: string,
  claimsPart: string,
  key: KeyObject = RSA.privateKey,
  algorithm: McpAccessTokenAlgorithm = 'RS256'
): string {
  const options =
    algorithm === 'RS256'
      ? { key, padding: constants.RSA_PKCS1_PADDING }
      : { key, dsaEncoding: 'ieee-p1363' as const };
  const signature = sign('sha256', Buffer.from(`${headerPart}.${claimsPart}`), options);
  return `${headerPart}.${claimsPart}.${signature.toString('base64url')}`;
}

function token(
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: KeyObject = RSA.privateKey,
  algorithm: McpAccessTokenAlgorithm = 'RS256'
): string {
  return signParts(
    Buffer.from(
      JSON.stringify({
        typ: 'at+jwt',
        alg: algorithm,
        kid: algorithm === 'RS256' ? 'rsa-1' : 'ec-1',
        ...header,
      })
    ).toString('base64url'),
    Buffer.from(JSON.stringify(claims(overrides))).toString('base64url'),
    key,
    algorithm
  );
}

function expectInvalid(value: unknown, config = configuration()): void {
  const verifier = createMcpAccessTokenVerifier(config);
  expect(() => verifier.verify(value as string)).toThrow(InvalidTokenError);
  expect(() => verifier.verify(value as string)).toThrow('Invalid MCP access token');
}

afterEach(() => vi.restoreAllMocks());

describe('MCP deployment-selected RFC 9068 access-token profile', () => {
  it('verifies RS256 and returns only immutable authentication evidence', () => {
    const verifier = createMcpAccessTokenVerifier(configuration());
    const evidence = verifier.verify(
      token({
        token_use: 'access',
        member_id: 'owner',
        role: 'localadmin',
        roles: ['admin'],
        tenant: 'untrusted-tenant',
        token: 'never-return-this',
      })
    );
    expect(evidence).toEqual({
      issuer: ISSUER,
      subject: 'subject-1',
      scopes: ['requests:read', 'requests:submit'],
      expiresAt: NOW + 60,
      clientId: 'client-1',
    });
    expect(Object.isFrozen(verifier)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.scopes)).toBe(true);
    expect(() => (evidence.scopes as string[]).push('admin')).toThrow();
    expect(() => Object.assign(evidence, { subject: 'owner' })).toThrow();
  });

  it('verifies ES256 using JOSE P1363 signatures and the full access-token media type', () => {
    expect(
      createMcpAccessTokenVerifier(configuration()).verify(
        token({}, { typ: 'application/at+jwt' }, EC.privateKey, 'ES256')
      ).subject
    ).toBe('subject-1');
  });

  it('rejects DER-encoded ES256 signatures', () => {
    const [header, payload] = token({}, {}, EC.privateKey, 'ES256').split('.');
    const der = sign('sha256', Buffer.from(`${header}.${payload}`), EC.privateKey);
    expectInvalid(`${header}.${payload}.${der.toString('base64url')}`);
  });

  it('accepts a singleton resource audience and preserves unknown scopes without granting authority', () => {
    expect(
      createMcpAccessTokenVerifier(configuration()).verify(
        token({
          aud: [RESOURCE],
          scope: 'unrecognized:scope localadmin',
        })
      )
    ).toEqual({
      issuer: ISSUER,
      subject: 'subject-1',
      scopes: ['unrecognized:scope', 'localadmin'],
      expiresAt: NOW + 60,
      clientId: 'client-1',
    });
  });

  it('matches issuer/resource exactly, preserving tenant paths and trailing slashes', () => {
    const config = configuration({ issuer: `${ISSUER}/`, resource: `${RESOURCE}/` });
    const verifier = createMcpAccessTokenVerifier(config);
    expect(verifier.verify(token({ iss: `${ISSUER}/`, aud: `${RESOURCE}/` })).issuer).toBe(
      `${ISSUER}/`
    );
    expectInvalid(token(), config);
  });

  it.each([
    ['wrong issuer', { iss: 'https://other.example' }],
    ['issuer case normalization', { iss: 'https://ISSUER.example/tenant' }],
    ['wrong audience', { aud: 'https://other.example/mcp' }],
    ['audience prefix', { aud: `${RESOURCE}/extra` }],
    ['audience wildcard', { aud: 'https://resource.example/*' }],
    ['multiple audiences', { aud: [RESOURCE, 'https://other.example'] }],
    ['duplicate audiences', { aud: [RESOURCE, RESOURCE] }],
    ['nested audience', { aud: [[RESOURCE]] }],
    ['empty audience array', { aud: [] }],
    ['expired token', { exp: NOW - 1 }],
    ['expiry equality', { exp: NOW }],
    ['future issuance', { iat: NOW + 0.01 }],
    ['issuance after expiry', { iat: NOW - 1, exp: NOW - 2 }],
    ['equal issuance and expiry', { iat: NOW, exp: NOW }],
    ['future not-before', { nbf: NOW + 0.01 }],
    ['not-before at expiry', { nbf: NOW + 60 }],
    ['negative expiry', { exp: -1 }],
    ['negative issuance', { iat: -1 }],
    ['negative not-before', { nbf: -1 }],
    ['unsafe expiry', { exp: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe issuance', { iat: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe not-before', { nbf: Number.MAX_SAFE_INTEGER + 1 }],
    ['string expiry', { exp: `${NOW + 60}` }],
    ['string issuance', { iat: `${NOW - 60}` }],
    ['string not-before', { nbf: `${NOW - 60}` }],
    ['null not-before', { nbf: null }],
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['padded subject', { sub: ' subject-1' }],
    ['control subject', { sub: 'subject\u0000' }],
    ['oversize subject', { sub: 's'.repeat(1_025) }],
    ['numeric subject', { sub: 123 }],
    ['empty client id', { client_id: '' }],
    ['empty token id', { jti: '' }],
    ['ID-token purpose', { token_use: 'id' }],
    ['refresh-token purpose', { token_use: 'refresh' }],
    ['malformed purpose', { token_use: ['access'] }],
  ] as Array<[string, Record<string, unknown>]>)('rejects %s', (_name, overrides) => {
    expectInvalid(token(overrides));
  });

  it.each(['iss', 'aud', 'exp', 'iat', 'sub', 'client_id', 'jti', 'scope'])(
    'requires %s',
    (claim) => {
      expectInvalid(token({ [claim]: undefined }));
    }
  );

  it('accepts exact not-before/issuance boundaries and fractional NumericDate values', () => {
    const verifier = createMcpAccessTokenVerifier(configuration());
    expect(verifier.verify(token({ iat: NOW, nbf: NOW, exp: NOW + 0.01 })).expiresAt).toBe(
      NOW + 0.01
    );
    expect(verifier.verify(token({ iat: NOW - 0.5, nbf: NOW - 0.25 })).subject).toBe('subject-1');
  });

  it.each(['exp', 'iat', 'nbf'])('rejects non-finite %s JSON NumericDates', (name) => {
    const header = Buffer.from(
      JSON.stringify({ typ: 'at+jwt', alg: 'RS256', kid: 'rsa-1' })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify(claims({ [name]: '__infinity__' })).replace('"__infinity__"', '1e999')
    ).toString('base64url');
    expectInvalid(signParts(header, payload));
  });

  it.each([
    '',
    ' ',
    'read  write',
    ' read',
    'read ',
    'read\twrite',
    'read\nwrite',
    'read read',
    'quoted"scope',
    'back\\slash',
    'nonascii-é',
    's'.repeat(257),
    Array.from({ length: 65 }, (_, i) => `s${i}`).join(' '),
    Array.from({ length: 20 }, (_, i) => `${i}${'s'.repeat(250)}`).join(' '),
    ['read'],
    null,
    123,
  ])('rejects malformed or unbounded scope %#', (scope) => {
    expectInvalid(token({ scope }));
  });

  it('accepts the complete RFC 6749 ASCII scope-token grammar', () => {
    const scope = String.fromCharCode(
      ...Array.from({ length: 94 }, (_, i) => i + 33).filter((n) => n !== 34 && n !== 92)
    );
    expect(createMcpAccessTokenVerifier(configuration()).verify(token({ scope })).scopes).toEqual([
      scope,
    ]);
  });

  it('uses the clock on every verification and expires precisely at exp', () => {
    let now = NOW;
    const verifier = createMcpAccessTokenVerifier(configuration({ nowSeconds: () => now }));
    const bearer = token();
    expect(verifier.verify(bearer).expiresAt).toBe(NOW + 60);
    now = NOW + 60;
    expect(() => verifier.verify(bearer)).toThrow(InvalidTokenError);
  });

  it('uses the real clock only when no trusted clock dependency is supplied', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
    expect(
      createMcpAccessTokenVerifier(configuration({ nowSeconds: undefined })).verify(token()).subject
    ).toBe('subject-1');
  });

  it.each([NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    'fails closed for invalid clock %#',
    (now) => {
      expectInvalid(token(), configuration({ nowSeconds: () => now }));
    }
  );
});

describe('MCP access-token JOSE trust boundary', () => {
  it.each([
    ['ID-token typ', { typ: 'JWT' }],
    ['missing typ', { typ: undefined }],
    ['wrong typ', { typ: 'id+jwt' }],
    ['missing kid', { kid: undefined }],
    ['unknown kid', { kid: 'unknown' }],
    ['oversize kid', { kid: 'k'.repeat(257) }],
    ['wrong key type', { kid: 'ec-1' }],
    ['unsigned algorithm', { alg: 'none' }],
    ['symmetric algorithm', { alg: 'HS256' }],
    ['unapproved RSA algorithm', { alg: 'RS512' }],
    ['critical header', { crit: [] }],
    ['critical extension', { crit: ['b64'], b64: false }],
    ['embedded JWK', { jwk: RSA_JWK }],
    ['remote JWKS URL', { jku: 'https://attacker.example/jwks' }],
    ['remote certificate URL', { x5u: 'https://attacker.example/cert' }],
    ['embedded certificate chain', { x5c: ['attacker-certificate'] }],
    ['certificate thumbprint', { x5t: 'attacker-thumbprint' }],
    ['nested JWT', { cty: 'JWT' }],
    ['unencoded payload', { b64: false }],
    ['unknown header', { other: true }],
  ] as Array<[string, Record<string, unknown>]>)('rejects %s', (_name, header) => {
    expectInvalid(token({}, header));
  });

  it('requires the key algorithm to be enabled independently of the token header', () => {
    const config = configuration({ algorithms: ['RS256'], jwks: { keys: [RSA_JWK] } });
    expectInvalid(token({}, {}, EC.privateKey, 'ES256'), config);
  });

  it('rejects bad signatures and tampering with either signed part', () => {
    expectInvalid(token({}, {}, OTHER_RSA.privateKey));
    const [header, payload, signature] = token().split('.');
    const changedPayload = Buffer.from(JSON.stringify(claims({ sub: 'owner' }))).toString(
      'base64url'
    );
    expectInvalid(`${header}.${changedPayload}.${signature}`);
    const changedHeader = Buffer.from(
      JSON.stringify({ typ: 'application/at+jwt', alg: 'RS256', kid: 'rsa-1' })
    ).toString('base64url');
    expectInvalid(`${changedHeader}.${payload}.${signature}`);
  });

  it('does not confuse an RSA public key with an HMAC secret', () => {
    const header = Buffer.from(
      JSON.stringify({ typ: 'at+jwt', alg: 'HS256', kid: 'rsa-1' })
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims())).toString('base64url');
    const data = `${header}.${payload}`;
    const signature = createHmac('sha256', RSA.publicKey.export({ type: 'spki', format: 'pem' }))
      .update(data)
      .digest('base64url');
    expectInvalid(`${data}.${signature}`);
  });

  it('rejects RSA-PSS signatures labeled as RS256', () => {
    const [header, payload] = token().split('.');
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
      key: RSA.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    expectInvalid(`${header}.${payload}.${signature.toString('base64url')}`);
  });

  it.each([undefined, null, 123, '', 'a.b', 'a.b.c.d', 'a.b.', 'a.b.c', 'x'.repeat(16_385)])(
    'rejects malformed compact token %#',
    (value) => {
      expectInvalid(value);
    }
  );

  it('enforces the 16 KiB token bound on otherwise valid signed tokens', () => {
    const emptyLength = token({ padding: '' }).length;
    const padding = 'x'.repeat(Math.floor(((16_384 - emptyLength) * 3) / 4));
    const withinBound = token({ padding });
    expect(withinBound.length).toBeLessThanOrEqual(16_384);
    expect(withinBound.length).toBeGreaterThan(16_382);
    expect(createMcpAccessTokenVerifier(configuration()).verify(withinBound).subject).toBe(
      'subject-1'
    );
    const overBound = token({ padding: `${padding}xx` });
    expect(overBound.length).toBeGreaterThan(16_384);
    expectInvalid(overBound);
  });

  it('rejects base64url padding, invalid characters, and noncanonical trailing bits', () => {
    const [header, payload, signature] = token().split('.');
    expectInvalid(`${header}=.${payload}.${signature}`);
    expectInvalid(`${header}.${payload}.${signature}=`);
    expectInvalid(`${header}.${payload}.${signature.slice(0, -1)}+`);
    // A 256-byte signature ends with four unused bits; changing just those
    // bits decodes to the same signature but must fail canonical encoding.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(signature.at(-1)!);
    expect(last % 16).toBe(0);
    expectInvalid(`${header}.${payload}.${signature.slice(0, -1)}${alphabet[last + 1]}`);
  });

  it.each(['[]', 'null', 'true', '123', '"text"', '{', '{"__proto__":{"admin":true}}'])(
    'rejects unsafe/non-object JSON %#',
    (raw) => {
      const [header, payload] = token().split('.');
      const part = Buffer.from(raw).toString('base64url');
      expectInvalid(signParts(part, payload));
      expectInvalid(signParts(header, part));
    }
  );

  it('rejects invalid UTF-8 rather than accepting decoder replacement characters', () => {
    const [header] = token().split('.');
    const text = JSON.stringify(claims({ sub: '__invalid__' }));
    const [prefix, suffix] = text.split('__invalid__');
    const invalid = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([0xff]),
      Buffer.from(suffix),
    ]).toString('base64url');
    expectInvalid(signParts(header, invalid));
  });

  it('does not fetch token-controlled key sources and never exposes bearer details in errors', () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network permitted'));
    const bearer = token({ sub: 'sensitive-subject' }, { jku: 'https://attacker.example/key' });
    try {
      createMcpAccessTokenVerifier(configuration()).verify(bearer);
      expect.fail('Expected InvalidTokenError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTokenError);
      expect((error as InvalidTokenError).toResponseObject()).toEqual({
        error: 'invalid_token',
        error_description: 'Invalid MCP access token',
      });
      expect(String(error)).not.toContain('sensitive-subject');
      expect(String(error)).not.toContain('attacker.example');
      expect(String(error)).not.toContain(bearer);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('MCP access-token pinned verifier configuration', () => {
  it.each([
    'http://issuer.example',
    'file:///issuer',
    '*',
    'https://*.example',
    'https://%2a.example',
    'https://user:password@issuer.example',
    'https://issuer.example?query',
    'https://issuer.example?',
    'https://issuer.example#fragment',
    'https://issuer.example#',
    ' https://issuer.example',
    'https://issuer.example\n',
    'https:\\issuer.example',
    'https://',
    '',
  ])('rejects unsafe issuer/resource configuration %#', (value) => {
    for (const field of ['issuer', 'resource']) {
      expect(() => createMcpAccessTokenVerifier(configuration({ [field]: value }))).toThrow(
        'configuration'
      );
    }
  });

  it.each([
    'https://RESOURCE.example/mcp',
    'https://resource.example:443/mcp',
    'https://resource.example/a/../mcp',
    'https://resource.example/./mcp',
    'https://resource.example/%2e/mcp',
    'https://resource.example',
  ])('rejects noncanonical resource metadata mismatch %#', (resource) => {
    expect(() => createMcpAccessTokenVerifier(configuration({ resource }))).toThrow(
      'resource must be a canonical HTTPS URL'
    );
  });

  it('retains byte-exact issuer matching without applying resource canonicalization to it', () => {
    const issuer = 'https://ISSUER.example:443/tenant';
    const verifier = createMcpAccessTokenVerifier(configuration({ issuer }));
    expect(verifier.verify(token({ iss: issuer })).issuer).toBe(issuer);
    expect(() => verifier.verify(token({ iss: new URL(issuer).href }))).toThrow(InvalidTokenError);
  });

  it('accepts canonical resource URLs while continuing to reject nonexact token audiences', () => {
    const resource = 'https://resource.example:8443/mcp/';
    const verifier = createMcpAccessTokenVerifier(configuration({ resource }));
    expect(verifier.verify(token({ aud: resource })).subject).toBe('subject-1');
    expect(() => verifier.verify(token({ aud: 'https://RESOURCE.example:8443/mcp/' }))).toThrow(
      InvalidTokenError
    );
  });

  it.each(
    [[], ['none'], ['HS256'], ['RS256', 'RS256'], ['RS256', 'ES256', 'RS512'], undefined].map(
      (algorithms) => ({ algorithms })
    )
  )('requires explicit bounded algorithm allowlist %#', ({ algorithms }) => {
    expect(() =>
      createMcpAccessTokenVerifier(
        configuration({ algorithms: algorithms as McpAccessTokenAlgorithm[] })
      )
    ).toThrow('configuration');
  });

  it.each([undefined, null, {}, { keys: [] }, { keys: 'not-an-array' }])(
    'requires pinned public JWKS %#',
    (jwks) => {
      expect(() =>
        createMcpAccessTokenVerifier(
          configuration({ jwks: jwks as McpAccessTokenVerifierConfig['jwks'] })
        )
      ).toThrow('configuration');
    }
  );

  it('rejects sparse algorithm arrays rather than treating holes as approval', () => {
    const algorithms: McpAccessTokenAlgorithm[] = ['RS256'];
    algorithms.length = 2;
    expect(() =>
      createMcpAccessTokenVerifier(configuration({ algorithms, jwks: { keys: [RSA_JWK] } }))
    ).toThrow('configuration');
  });

  it('rejects hidden private fields, symbols, inherited key material, and non-object keys', () => {
    const hidden = Object.defineProperty({ ...RSA_JWK }, 'd', {
      value: 'private',
      enumerable: false,
    });
    const inherited = Object.create(RSA_JWK) as McpPublicJsonWebKey;
    const symbol = { ...RSA_JWK, [Symbol('private')]: 'private' };
    for (const key of [hidden, inherited, symbol, null, [], 'public-key']) {
      expect(() =>
        createMcpAccessTokenVerifier(
          configuration({ jwks: { keys: [key as McpPublicJsonWebKey] } })
        )
      ).toThrow('configuration');
    }
  });

  it('caps JWKS at 16 keys and rejects duplicate kids even across algorithms', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ ...RSA_JWK, kid: `key-${i}` }));
    const config = configuration({ jwks: { keys: sixteen } });
    expect(createMcpAccessTokenVerifier(config).verify(token({}, { kid: 'key-15' })).subject).toBe(
      'subject-1'
    );
    expect(() =>
      createMcpAccessTokenVerifier(
        configuration({ jwks: { keys: [...sixteen, { ...RSA_JWK, kid: 'key-16' }] } })
      )
    ).toThrow('1–16');
    for (const duplicate of [RSA_JWK, { ...EC_JWK, kid: RSA_JWK.kid }]) {
      expect(() =>
        createMcpAccessTokenVerifier(configuration({ jwks: { keys: [RSA_JWK, duplicate] } }))
      ).toThrow('unique');
    }
  });

  it.each([
    ['missing kid', { ...RSA_JWK, kid: undefined }],
    ['empty kid', { ...RSA_JWK, kid: '' }],
    ['oversize kid', { ...RSA_JWK, kid: 'k'.repeat(257) }],
    ['missing algorithm', { ...RSA_JWK, alg: undefined }],
    ['unknown algorithm', { ...RSA_JWK, alg: 'RS512' }],
    ['wrong key type', { ...RSA_JWK, kty: 'oct' }],
    ['encryption key use', { ...RSA_JWK, use: 'enc' }],
    ['signing key operation', { ...RSA_JWK, key_ops: ['sign'] }],
    ['extra key operation', { ...RSA_JWK, key_ops: ['verify', 'encrypt'] }],
    ['empty key operation', { ...RSA_JWK, key_ops: [] }],
    ['string key operation', { ...RSA_JWK, key_ops: 'verify' }],
    ['symmetric secret', { ...RSA_JWK, k: 'c2VjcmV0' }],
    ['private exponent', { ...RSA_JWK, d: 'c2VjcmV0' }],
    ['private factor', { ...RSA_JWK, p: 'c2VjcmV0' }],
    ['private multiprime parameters', { ...RSA_JWK, oth: [] }],
    ['remote key URL', { ...RSA_JWK, jku: 'https://attacker.example/key' }],
    ['remote certificate URL', { ...RSA_JWK, x5u: 'https://attacker.example/cert' }],
    ['embedded certificate', { ...RSA_JWK, x5c: ['certificate'] }],
    ['embedded key', { ...RSA_JWK, jwk: EC_JWK }],
    ['mixed RSA/EC material', { ...RSA_JWK, x: EC_JWK.x }],
    ['oversize modulus', { ...RSA_JWK, n: Buffer.alloc(1_025, 255).toString('base64url') }],
    ['oversize exponent', { ...RSA_JWK, e: Buffer.alloc(9, 255).toString('base64url') }],
    ['padded modulus', { ...RSA_JWK, n: `${RSA_JWK.n}=` }],
    [
      'nonminimal modulus',
      {
        ...RSA_JWK,
        n: Buffer.concat([Buffer.alloc(1), Buffer.from(RSA_JWK.n, 'base64url')]).toString(
          'base64url'
        ),
      },
    ],
    ['invalid exponent', { ...RSA_JWK, e: 'Ag' }],
    ['wrong curve', { ...EC_JWK, crv: 'P-384' }],
    ['short coordinate', { ...EC_JWK, x: 'AQ' }],
    ['oversize coordinate', { ...EC_JWK, x: Buffer.alloc(33).toString('base64url') }],
    [
      'invalid curve point',
      {
        ...EC_JWK,
        x: Buffer.alloc(32).toString('base64url'),
        y: Buffer.alloc(32).toString('base64url'),
      },
    ],
    ['mixed EC/RSA material', { ...EC_JWK, n: RSA_JWK.n }],
  ] as Array<[string, McpPublicJsonWebKey]>)(
    'rejects %s configuration before verifying tokens',
    (_name, key) => {
      expect(() => createMcpAccessTokenVerifier(configuration({ jwks: { keys: [key] } }))).toThrow(
        'configuration'
      );
    }
  );

  it('rejects private JWK exports and RSA keys below 2048 bits', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1_024 }).publicKey.export({
      format: 'jwk',
    });
    for (const key of [RSA.privateKey.export({ format: 'jwk' }), weak]) {
      expect(() =>
        createMcpAccessTokenVerifier(
          configuration({ jwks: { keys: [{ ...key, kid: 'rsa-1', alg: 'RS256' }] } })
        )
      ).toThrow('configuration');
    }
  });

  it('allows explicit sig/verify metadata and fails a disabled key algorithm', () => {
    expect(
      createMcpAccessTokenVerifier(
        configuration({ jwks: { keys: [{ ...RSA_JWK, use: 'sig', key_ops: ['verify'] }] } })
      ).verify(token()).subject
    ).toBe('subject-1');
    expect(() => createMcpAccessTokenVerifier(configuration({ algorithms: ['ES256'] }))).toThrow(
      'enabled signing algorithm'
    );
  });

  it('captures config values, algorithm arrays, key objects, and clock reference at creation', () => {
    const key = { ...RSA_JWK, use: 'sig', key_ops: ['verify'] };
    const config = {
      issuer: ISSUER,
      resource: RESOURCE,
      algorithms: ['RS256'] as McpAccessTokenAlgorithm[],
      jwks: { keys: [key] },
      nowSeconds: () => NOW,
    };
    const verifier = createMcpAccessTokenVerifier(config);
    config.issuer = 'https://attacker.example';
    config.resource = 'https://attacker.example/mcp';
    config.algorithms.splice(0, 1, 'ES256');
    config.nowSeconds = () => NOW + 1_000;
    key.kid = 'attacker';
    key.n = OTHER_RSA.publicKey.export({ format: 'jwk' }).n;
    key.key_ops.push('sign');
    config.jwks.keys.length = 0;
    expect(verifier.verify(token()).subject).toBe('subject-1');
    expect(() => verifier.verify(token({}, {}, OTHER_RSA.privateKey))).toThrow(InvalidTokenError);
    expect(() => verifier.verify(token({ iss: config.issuer, aud: config.resource }))).toThrow(
      InvalidTokenError
    );
  });

  it('rejects malformed factory/clock input without misclassifying it as a token failure', () => {
    for (const config of [
      null,
      undefined,
      configuration({ nowSeconds: 123 as unknown as () => number }),
    ]) {
      expect(() => createMcpAccessTokenVerifier(config)).toThrow('configuration');
      expect(() => createMcpAccessTokenVerifier(config)).not.toThrow(InvalidTokenError);
    }
  });
});

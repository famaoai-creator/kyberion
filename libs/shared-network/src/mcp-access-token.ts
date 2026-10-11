import { constants, createPublicKey, verify, type KeyObject, type webcrypto } from 'node:crypto';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation/safe-json';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export type McpAccessTokenAlgorithm = 'RS256' | 'ES256';

/** A configuration-supplied JWK, never a token-supplied key or discovery URL. */
export interface McpPublicJsonWebKey {
  readonly kty?: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly [name: string]: unknown;
}

export interface McpAccessTokenVerifierConfig {
  readonly issuer: string;
  readonly resource: string;
  readonly algorithms: readonly McpAccessTokenAlgorithm[];
  readonly jwks: { readonly keys: readonly McpPublicJsonWebKey[] };
  /** Trusted dependency for deterministic tests; never populated from a request. */
  readonly nowSeconds?: () => number;
}

/** Authentication evidence only. Membership and authorization are resolved separately. */
export interface VerifiedMcpAccessToken {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly clientId: string;
}

export interface McpAccessTokenVerifier {
  verify(token: string): VerifiedMcpAccessToken;
}

const MAX_TOKEN_BYTES = 16_384;
const MAX_KEYS = 16;
const MAX_IDENTIFIER_LENGTH = 1_024;
const MAX_KID_LENGTH = 256;
const MAX_SCOPE_LENGTH = 4_096;
const MAX_SCOPES = 64;
const MAX_SCOPE_TOKEN_LENGTH = 256;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEADER_FIELDS = new Set(['alg', 'kid', 'typ']);
const PUBLIC_KEY_FIELDS = new Set([
  'kty',
  'kid',
  'alg',
  'use',
  'key_ops',
  'n',
  'e',
  'crv',
  'x',
  'y',
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

interface PinnedKey {
  readonly algorithm: McpAccessTokenAlgorithm;
  readonly key: KeyObject;
  readonly signatureBytes: number;
}

function configError(reason: string): never {
  throw new Error(`Invalid MCP access-token verifier configuration: ${reason}`);
}

function isAlgorithm(value: unknown): value is McpAccessTokenAlgorithm {
  return value === 'RS256' || value === 'ES256';
}

function isIdentifier(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validateHttpsIdentifier(value: unknown, label: string): string {
  if (!isIdentifier(value, 2_048) || !value.startsWith('https://') || /[\s\\*?#]/u.test(value)) {
    configError(`${label} must be an exact HTTPS URL without wildcard, query, or fragment`);
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.hostname.includes('*') ||
      url.username ||
      url.password
    ) {
      configError(`${label} must be an HTTPS URL without credentials`);
    }
  } catch {
    configError(`${label} must be an HTTPS URL without credentials`);
  }
  // Do not normalize an OAuth issuer/resource identifier before exact matching.
  return value;
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL.test(value)) throw new Error('Invalid base64url');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('Noncanonical base64url');
  return decoded;
}

function keyBytes(value: unknown, min: number, max: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil((max * 4) / 3)) {
    configError('public key material exceeds the supported bounds');
  }
  let decoded: Buffer;
  try {
    decoded = decodeBase64Url(value);
  } catch {
    configError('public key material must use canonical base64url');
  }
  if (decoded.length < min || decoded.length > max) {
    configError('public key material exceeds the supported bounds');
  }
  return decoded;
}

function pinKey(candidate: McpPublicJsonWebKey, algorithms: ReadonlySet<string>): PinnedKey {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null) ||
    Reflect.ownKeys(candidate).some(
      (field) => typeof field !== 'string' || !PUBLIC_KEY_FIELDS.has(field)
    )
  ) {
    configError('JWKS must contain only public signing-key fields');
  }
  if (!isIdentifier(candidate.kid, MAX_KID_LENGTH)) configError('each JWK needs a bounded kid');
  if (!isAlgorithm(candidate.alg) || !algorithms.has(candidate.alg)) {
    configError('each JWK needs an explicitly enabled signing algorithm');
  }
  if (candidate.use !== undefined && candidate.use !== 'sig') configError('JWK use must be sig');
  if (
    candidate.key_ops !== undefined &&
    (!Array.isArray(candidate.key_ops) ||
      candidate.key_ops.length !== 1 ||
      candidate.key_ops[0] !== 'verify')
  ) {
    configError('JWK key_ops must contain only verify');
  }

  // Copy only verified public material into Node's key importer. The caller's
  // mutable object, metadata, and arrays are not retained in the trust snapshot.
  let material: webcrypto.JsonWebKey;
  if (candidate.alg === 'RS256') {
    if (candidate.kty !== 'RSA' || ['crv', 'x', 'y'].some((field) => field in candidate)) {
      configError('RS256 requires an RSA public key');
    }
    const n = keyBytes(candidate.n, 256, 1_024);
    const e = keyBytes(candidate.e, 1, 8);
    if (n[0] === 0 || e[0] === 0) configError('RSA integers must use minimal encoding');
    material = { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') };
  } else {
    if (
      candidate.kty !== 'EC' ||
      candidate.crv !== 'P-256' ||
      ['n', 'e'].some((field) => field in candidate)
    ) {
      configError('ES256 requires a P-256 public key');
    }
    material = {
      kty: 'EC',
      crv: 'P-256',
      x: keyBytes(candidate.x, 32, 32).toString('base64url'),
      y: keyBytes(candidate.y, 32, 32).toString('base64url'),
    };
  }

  let key: KeyObject;
  try {
    key = createPublicKey({ key: material, format: 'jwk' });
  } catch {
    configError('public signing key could not be imported');
  }
  if (key.type !== 'public') configError('only public keys may verify access tokens');
  if (candidate.alg === 'RS256') {
    const bits = key.asymmetricKeyDetails?.modulusLength;
    const exponent = key.asymmetricKeyDetails?.publicExponent;
    if (
      key.asymmetricKeyType !== 'rsa' ||
      !bits ||
      bits < 2_048 ||
      bits > 8_192 ||
      exponent === undefined ||
      exponent < 3n ||
      exponent % 2n !== 1n
    ) {
      configError('RSA signing keys must have 2048–8192 bits and a valid public exponent');
    }
    return { algorithm: candidate.alg, key, signatureBytes: Math.ceil(bits / 8) };
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    configError('ES256 requires a P-256 public key');
  }
  return { algorithm: candidate.alg, key, signatureBytes: 64 };
}

function decodeObject(part: string): Record<string, unknown> {
  return parseSafeJsonObjectValue(
    parseSafeJsonInput(UTF8.decode(decodeBase64Url(part)), 'MCP access token'),
    'MCP access token'
  );
}

function isNumericDate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function parseScopes(value: unknown): readonly string[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SCOPE_LENGTH) {
    throw new Error('Invalid scope');
  }
  const scopes = value.split(' ');
  // RFC 6749 scope-token excludes double quote and backslash. Single ASCII
  // spaces separate entries; tabs, repeated spaces, and duplicates are rejected.
  if (
    scopes.length > MAX_SCOPES ||
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) => scope.length > MAX_SCOPE_TOKEN_LENGTH || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)
    )
  ) {
    throw new Error('Invalid scope');
  }
  return Object.freeze(scopes);
}

/**
 * Strict, deployment-selected RFC 9068 access-token profile, NOT a general MCP
 * requirement that all OAuth access tokens use JWTs. HTTPS exact issuer/resource,
 * a canonical resource URL matching the HTTP metadata URL serialization,
 * one audience, at+jwt purpose, bounded public pinned JWKS, and explicit RS256 /
 * ES256 are required. Only alg/kid/typ JOSE headers are supported. Mandatory
 * exp/iat/sub/client_id/jti/scope, zero clock skew, and bounded unique scopes are
 * additional deployment constraints. token_use, when present, must be access.
 *
 * This resource server neither fetches/refreshes keys nor performs discovery,
 * revocation checks, token exchange, replay prevention, or member authorization.
 * Recreate the verifier to rotate its configuration-approved public-key snapshot.
 * RFC 9068: https://www.rfc-editor.org/rfc/rfc9068.html
 */
export function createMcpAccessTokenVerifier(
  config: McpAccessTokenVerifierConfig
): McpAccessTokenVerifier {
  if (!config || typeof config !== 'object') configError('configuration is required');
  const issuer = validateHttpsIdentifier(config.issuer, 'issuer');
  const resource = validateHttpsIdentifier(config.resource, 'resource');
  // HTTP metadata serializes its resource with URL.href. Reject a deployment
  // mismatch here; never normalize a token's audience or issuer while verifying.
  if (resource !== new URL(resource).href) {
    configError('resource must be a canonical HTTPS URL matching its URL.href serialization');
  }
  if (
    !Array.isArray(config.algorithms) ||
    config.algorithms.length === 0 ||
    config.algorithms.length > 2 ||
    [...config.algorithms].some((algorithm) => !isAlgorithm(algorithm)) ||
    new Set(config.algorithms).size !== config.algorithms.length
  ) {
    configError('algorithms must explicitly allow RS256 and/or ES256 without duplicates');
  }
  const algorithms = new Set(config.algorithms);
  if (
    !Array.isArray(config.jwks?.keys) ||
    config.jwks.keys.length === 0 ||
    config.jwks.keys.length > MAX_KEYS
  ) {
    configError('JWKS must contain 1–16 pinned public keys');
  }
  const keys = new Map<string, PinnedKey>();
  for (const candidate of config.jwks.keys) {
    const pinned = pinKey(candidate, algorithms);
    if (keys.has(candidate.kid)) configError('JWKS kid values must be unique');
    keys.set(candidate.kid, pinned);
  }
  if (config.nowSeconds !== undefined && typeof config.nowSeconds !== 'function') {
    configError('nowSeconds must be a trusted clock function');
  }
  const nowSeconds = config.nowSeconds ?? (() => Date.now() / 1_000);

  return Object.freeze({
    verify(token: string): VerifiedMcpAccessToken {
      try {
        if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
          throw new Error('Invalid token size');
        }
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid compact JWT');
        const [headerPart, claimsPart, signaturePart] = parts;
        const header = decodeObject(headerPart);
        if (
          Object.keys(header).some((field) => !HEADER_FIELDS.has(field)) ||
          (header.typ !== 'at+jwt' && header.typ !== 'application/at+jwt') ||
          !isAlgorithm(header.alg) ||
          !algorithms.has(header.alg) ||
          !isIdentifier(header.kid, MAX_KID_LENGTH)
        ) {
          throw new Error('Invalid access-token header');
        }
        const pinned = keys.get(header.kid);
        if (!pinned || pinned.algorithm !== header.alg) throw new Error('Untrusted signing key');
        const signature = decodeBase64Url(signaturePart);
        if (signature.length !== pinned.signatureBytes) throw new Error('Invalid signature size');
        const signatureOptions =
          pinned.algorithm === 'RS256'
            ? { key: pinned.key, padding: constants.RSA_PKCS1_PADDING }
            : { key: pinned.key, dsaEncoding: 'ieee-p1363' as const };
        if (
          !verify(
            'sha256',
            Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'),
            signatureOptions,
            signature
          )
        ) {
          throw new Error('Invalid signature');
        }

        const claims = decodeObject(claimsPart);
        const now = nowSeconds();
        const audience =
          Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
        if (
          claims.iss !== issuer ||
          audience !== resource ||
          !isNumericDate(now) ||
          !isNumericDate(claims.exp) ||
          !isNumericDate(claims.iat) ||
          claims.exp <= now ||
          claims.iat > now ||
          claims.exp <= claims.iat ||
          (claims.nbf !== undefined &&
            (!isNumericDate(claims.nbf) || claims.nbf > now || claims.nbf >= claims.exp)) ||
          !isIdentifier(claims.sub) ||
          !isIdentifier(claims.client_id) ||
          !isIdentifier(claims.jti) ||
          (claims.token_use !== undefined && claims.token_use !== 'access')
        ) {
          throw new Error('Invalid access-token claims');
        }
        return Object.freeze({
          issuer,
          subject: claims.sub,
          scopes: parseScopes(claims.scope),
          expiresAt: claims.exp,
          clientId: claims.client_id,
        });
      } catch {
        // Never expose the bearer token, claims, kid, or crypto/parser details.
        throw new InvalidTokenError('Invalid MCP access token');
      }
    },
  });
}

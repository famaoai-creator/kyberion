/**
 * Hermetic WebAuthn authenticator for tests: a real P-256 key, `none`
 * attestation, and assertions signed the way a browser authenticator signs
 * them — so `@simplewebauthn/server` verifies them without any network or
 * device.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

function counterBytes(counter: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(counter);
  return out;
}

export interface TestAuthenticator {
  credentialId: string;
  register(input: { challenge: string; origin: string; rpId: string }): RegistrationResponseJSON;
  assert(input: {
    challenge: string;
    origin: string;
    rpId: string;
    counter: number;
    userVerified?: boolean;
  }): AuthenticationResponseJSON;
}

export function createTestAuthenticator(): TestAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coseKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(String(jwk.x), 'base64url'))],
      [-3, new Uint8Array(Buffer.from(String(jwk.y), 'base64url'))],
    ])
  );
  const credentialIdBytes = randomBytes(32);
  const credentialId = b64url(credentialIdBytes);
  const rpIdHash = (rpId: string) => createHash('sha256').update(rpId).digest();

  return {
    credentialId,
    register({ challenge, origin, rpId }) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })
      );
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialIdBytes.length);
      const authData = Buffer.concat([
        rpIdHash(rpId),
        Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
        counterBytes(0),
        Buffer.alloc(16),
        idLength,
        credentialIdBytes,
        Buffer.from(coseKey),
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, string | Map<string, never> | Uint8Array>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)],
        ])
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    assert({ challenge, origin, rpId, counter, userVerified = true }) {
      return signAssertion(privateKey, credentialId, {
        challenge,
        origin,
        authData: Buffer.concat([
          rpIdHash(rpId),
          Buffer.from([FLAG_UP | (userVerified ? FLAG_UV : 0)]),
          counterBytes(counter),
        ]),
      });
    },
  };
}

function signAssertion(
  privateKey: KeyObject,
  credentialId: string,
  input: { challenge: string; origin: string; authData: Buffer }
): AuthenticationResponseJSON {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge: input.challenge, origin: input.origin })
  );
  const signature = sign(
    'sha256',
    Buffer.concat([input.authData, createHash('sha256').update(clientDataJSON).digest()]),
    privateKey
  );
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(input.authData),
      signature: b64url(signature),
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
}

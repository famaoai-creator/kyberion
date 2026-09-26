import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TR-01: Chronos runs under SYSTEM_ROLE=chronos_mirror_v2, which cannot read
 * the personal tier. The chronos-access token registry is read through the
 * dedicated `chronos_token_registry_reader` role, whose only grant is that one
 * file. These tests run the real secure-io / tier-guard / secret-guard stack
 * against a hermetic KYBERION_ROOT with a copy of the checked-in governance
 * policies (knowledge/product/governance, schemas) and holds its own personal tier.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENV_KEYS = [
  'KYBERION_ROOT',
  'SYSTEM_ROLE',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  'MISSION_ID',
  'KYBERION_SECRET_ENCRYPTION',
] as const;
const REGISTRY_RELATIVE = 'knowledge/personal/connections/chronos-access.json';

let root = '';
const original: Record<string, string | undefined> = {};

function runtimeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

async function loadModules() {
  vi.resetModules();
  const authority = await import('./authority.js');
  const registry = await import('./chronos-access-registry.js');
  const tierGuard = await import('./tier-guard.js');
  const secureIo = await import('./secure-io.js');
  authority.resetRoleAssumptionPolicyCache();
  return { authority, registry, tierGuard, secureIo };
}

describe('TR-01 chronos_token_registry_reader', () => {
  let issued: { token: string; hash: string };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-chronos-token-reader-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"hermetic"}\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# hermetic\n');
    fs.mkdirSync(path.join(root, 'knowledge', 'personal', 'connections'), { recursive: true });
    fs.mkdirSync(path.join(root, 'knowledge', 'personal', 'tenants'), { recursive: true });
    // Copied, not linked: secure-io refuses symlinked governance paths
    // (policy engine, seam provider selection).
    for (const dir of ['governance', 'schemas']) {
      fs.cpSync(
        path.join(REPO_ROOT, 'knowledge', 'product', dir),
        path.join(root, 'knowledge', 'product', dir),
        { recursive: true }
      );
    }
    issued = runtimeToken();
    fs.writeFileSync(
      path.join(root, REGISTRY_RELATIVE),
      JSON.stringify({
        tokens: [{ token_hash: issued.hash, role: 'readonly', tenant_slugs: ['acme-corp'] }],
      })
    );
    fs.writeFileSync(
      path.join(root, 'knowledge/personal/connections/other-service.json'),
      '{"api":"placeholder"}\n'
    );
    fs.writeFileSync(path.join(root, 'knowledge/personal/tenants/acme-corp.json'), '{}\n');
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KYBERION_ROOT = root;
    process.env.SYSTEM_ROLE = 'chronos_mirror_v2';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    vi.resetModules();
  });

  it('cannot read the registry under the ambient chronos_mirror_v2 role', async () => {
    const { registry } = await loadModules();
    expect(() => registry.readChronosTokenRegistrations()).toThrow();
  });

  it('reads the registry under SYSTEM_ROLE=chronos_mirror_v2 through the reader role', async () => {
    const { authority, registry } = await loadModules();
    const registrations = authority.withExecutionContext(
      registry.CHRONOS_TOKEN_REGISTRY_READER_ROLE,
      () => registry.readChronosTokenRegistrations()
    );
    expect(registrations).not.toBeNull();
    expect(registry.findChronosTokenRegistration(issued.token, registrations ?? [])).toMatchObject({
      role: 'readonly',
      tenant_slugs: ['acme-corp'],
    });
  });

  it('may be assumed only by the surfaces that read the registry', async () => {
    const { authority, registry } = await loadModules();
    for (const systemRole of ['chronos_mirror_v2', 'concierge']) {
      expect(
        authority.isRoleAssumptionAllowed(systemRole, registry.CHRONOS_TOKEN_REGISTRY_READER_ROLE),
        systemRole
      ).toBe(true);
    }
    // computer_surface / presence_studio pass `registrations: null` to the
    // authn seam and never read the registry.
    for (const systemRole of ['computer_surface', 'presence_studio', 'slack_bridge']) {
      expect(
        authority.isRoleAssumptionAllowed(systemRole, registry.CHRONOS_TOKEN_REGISTRY_READER_ROLE),
        systemRole
      ).toBe(false);
    }
  });

  it('grants nothing beyond reading that single file', async () => {
    const { authority, registry, tierGuard } = await loadModules();
    const abs = (relative: string) => path.join(root, relative);
    const verdicts = authority.withExecutionContext(
      registry.CHRONOS_TOKEN_REGISTRY_READER_ROLE,
      () => ({
        persona: authority.resolveIdentityContext().persona,
        readRegistry: tierGuard.validateReadPermission(abs(REGISTRY_RELATIVE)).allowed,
        readOtherConnection: tierGuard.validateReadPermission(
          abs('knowledge/personal/connections/other-service.json')
        ).allowed,
        readSibling: tierGuard.validateReadPermission(
          abs('knowledge/personal/connections/chronos-access.json.bak')
        ).allowed,
        readTenant: tierGuard.validateReadPermission(
          abs('knowledge/personal/tenants/acme-corp.json')
        ).allowed,
        readConfidential: tierGuard.validateReadPermission(
          abs('knowledge/confidential/acme-corp/notes.md')
        ).allowed,
        writeRegistry: tierGuard.validateWritePermission(abs(REGISTRY_RELATIVE)).allowed,
        writePersonal: tierGuard.validateWritePermission(abs('knowledge/personal/notes.md'))
          .allowed,
        writeChronosCoordination: tierGuard.validateWritePermission(
          abs('active/shared/coordination/chronos/state.json')
        ).allowed,
        writeProduct: tierGuard.validateWritePermission(
          abs('knowledge/product/governance/security-policy.json')
        ).allowed,
      })
    );
    expect(verdicts).toEqual({
      persona: 'worker',
      readRegistry: true,
      readOtherConnection: false,
      readSibling: false,
      readTenant: false,
      readConfidential: false,
      writeRegistry: false,
      writePersonal: false,
      writeChronosCoordination: false,
      writeProduct: false,
    });
  });

  it('decrypts an encrypted-at-rest registry under the reader role (persona worker)', async () => {
    const { authority, registry } = await loadModules();
    const encryption = await import('./secret-encryption.js');
    const registryPath = path.join(root, REGISTRY_RELATIVE);
    const plaintext = fs.readFileSync(registryPath, 'utf8');
    encryption.overrideSecretEncryptionKeyForTests(randomBytes(32));
    try {
      const envelope = encryption.encryptConnectionDocument(
        JSON.parse(plaintext) as Record<string, unknown>
      );
      expect(encryption.isEncryptedConnectionEnvelope(envelope)).toBe(true);
      fs.writeFileSync(registryPath, `${JSON.stringify(envelope)}\n`);
      expect(fs.readFileSync(registryPath, 'utf8')).not.toContain(issued.hash);

      const result = authority.withExecutionContext(
        registry.CHRONOS_TOKEN_REGISTRY_READER_ROLE,
        () => ({
          persona: authority.resolveIdentityContext().persona,
          registrations: registry.readChronosTokenRegistrations(),
        })
      );
      expect(result.persona).toBe('worker');
      expect(
        registry.findChronosTokenRegistration(issued.token, result.registrations ?? [])
      ).toMatchObject({ role: 'readonly', tenant_slugs: ['acme-corp'] });
    } finally {
      encryption.overrideSecretEncryptionKeyForTests(null);
      fs.writeFileSync(registryPath, plaintext);
    }
  });

  it('reads the registry as the reader role through the authn seam (deps.registrations unset)', async () => {
    process.env.SYSTEM_ROLE = 'concierge';
    vi.resetModules();
    const rolesDuringRead: Array<string | undefined> = [];
    vi.doMock('./chronos-access-registry.js', async () => {
      const actual = await vi.importActual<typeof import('./chronos-access-registry.js')>(
        './chronos-access-registry.js'
      );
      const { resolveRole } = await import('./authority.js');
      return {
        ...actual,
        readChronosTokenRegistrations: () => {
          rolesDuringRead.push(resolveRole());
          return actual.readChronosTokenRegistrations();
        },
      };
    });
    try {
      const authority = await import('./authority.js');
      authority.resetRoleAssumptionPolicyCache();
      const { resolveAuthnSurfaceViewerScope } = await import('./surface-authn.js');
      // No `registrations` key: the registry-token provider reads the registry.
      const { scope, principal } = resolveAuthnSurfaceViewerScope({
        token: issued.token,
        local: false,
        serverTenant: 'acme-corp',
        surface: 'concierge',
      });
      expect(principal.provider).toBe('registry-token');
      expect(scope).toMatchObject({
        role: 'readonly',
        tenantSlugs: ['acme-corp'],
        source: 'token',
      });
      expect(rolesDuringRead.length).toBeGreaterThan(0);
      expect(new Set(rolesDuringRead)).toEqual(new Set(['chronos_token_registry_reader']));
      expect(authority.resolveRole()).toBe('concierge');
    } finally {
      vi.doUnmock('./chronos-access-registry.js');
    }
  });

  it('cannot store a registration through the governed writer', async () => {
    const { authority, registry } = await loadModules();
    expect(() =>
      authority.withExecutionContext(registry.CHRONOS_TOKEN_REGISTRY_READER_ROLE, () =>
        registry.issueChronosAccessToken({ role: 'readonly', tenantSlugs: ['acme-corp'] })
      )
    ).toThrow(/Sovereign Sanctuary: Access restricted/);
    const stored = JSON.parse(fs.readFileSync(path.join(root, REGISTRY_RELATIVE), 'utf8')) as {
      tokens: unknown[];
    };
    expect(stored.tokens).toHaveLength(1);
  });
});

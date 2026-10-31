import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { validateReadPermission } from '@agent/core/tier-guard';
import { safeLstat, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  transcribeWav,
  createPerceptionWorkDir,
  sniffMediaSignature,
  withPerceptionMediaRole,
} from './perception.js';
import { runListenCommand, transcribeMediaFile } from '../cli-listen.js';
import { createFakeDeps, fakeBridge, guardedReadBridge } from './perception.test-support.js';

// Tier-guard denials emit best-effort audit events; keep them off the real
// audit chain so the suite stays hermetic.
vi.mock('@agent/core/governance/audit-chain', () => ({
  auditChain: {
    record: vi.fn(),
  },
}));

const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_TIER',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_SCOPE_ENV_PATH',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ENTITY_GOVERNANCE',
] as const;

const TENANT = 'acme-corp';
const ROOT = pathResolver.rootDir();
const at = (relative: string): string => path.join(ROOT, relative);

describe('transcribeWav under a persisted confidential tenant scope', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // The interactive-CLI identity: persisted tier + tenant, no claim, no
    // role, persona resolves to 'unknown'.
    process.env.KYBERION_TIER = 'confidential';
    process.env.KYBERION_TENANT = TENANT;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('reads its own confidential tenant scratch through the assumed perception role', async () => {
    const input = path.join(pathResolver.sharedTmp(`listen-src-${randomUUID()}`), 'memo.wav');
    safeMkdir(path.dirname(input), { recursive: true });
    safeWriteFile(input, Buffer.from('RIFF'));
    // The real scratch dir on the confidential partition of the bound tenant.
    const workDir = createPerceptionWorkDir('listen', input);
    expect(workDir.replace(/\\/g, '/')).toContain(
      `active/shared/tmp/confidential/${TENANT}/perception/listen-`
    );
    const wav = path.join(workDir, 'audio-16k-mono.wav');
    safeWriteFile(wav, Buffer.from('RIFF'));
    try {
      // Before-state: the same identity cannot lstat the scratch it just wrote
      // — this was the reported ROLE_VIOLATION.
      expect(() => safeLstat(wav)).toThrow(/ROLE_VIOLATION/);
      const outcome = await transcribeWav(
        createFakeDeps({ bridges: [guardedReadBridge('guarded-stt')] }),
        wav,
        workDir,
        {}
      );
      expect(outcome.result.text).toBe('hello world');
    } finally {
      safeRmSync(workDir, { recursive: true, force: true });
      safeRmSync(path.dirname(input), { recursive: true, force: true });
    }
  });

  it('still denies the role a read across tenants inside transcribe', async () => {
    const input = path.join(pathResolver.sharedTmp(`listen-src-${randomUUID()}`), 'memo.wav');
    safeMkdir(path.dirname(input), { recursive: true });
    safeWriteFile(input, Buffer.from('RIFF'));
    const workDir = createPerceptionWorkDir('listen', input);
    const wav = path.join(workDir, 'audio-16k-mono.wav');
    safeWriteFile(wav, Buffer.from('RIFF'));
    const foreign = path.join(
      pathResolver.rootDir(),
      'active/shared/tmp/confidential/other-co/perception/listen-x/audio.wav'
    );
    try {
      await expect(
        transcribeWav(
          createFakeDeps({ bridges: [guardedReadBridge('nosy-stt', foreign)] }),
          wav,
          workDir,
          {}
        )
      ).rejects.toThrow(/permission_denied/);
    } finally {
      safeRmSync(workDir, { recursive: true, force: true });
      safeRmSync(path.dirname(input), { recursive: true, force: true });
    }
  });
});

describe('withPerceptionMediaRole under a persisted confidential tenant scope', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KYBERION_TIER = 'confidential';
    process.env.KYBERION_TENANT = TENANT;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('lets the wrapped read reach the bound tenant tmp/staging partitions', async () => {
    await withPerceptionMediaRole({ tier: 'confidential', tenant_slug: TENANT }, () => {
      for (const relative of [
        'active/shared/tmp/confidential/acme-corp/perception/see-x/frame-0001.png',
        'active/shared/tmp/personal/acme-corp/perception/see-x/frame-0001.png',
        'active/shared/staging/confidential/acme-corp/inbound/card.png',
        'active/shared/staging/personal/acme-corp/inbound/card.png',
      ]) {
        expect(validateReadPermission(at(relative)).allowed, relative).toBe(true);
      }
    });
  });

  it('takes no assumption for a public scope', async () => {
    await withPerceptionMediaRole({ tier: 'public' }, () => {
      // Still the caller's grant-less identity inside fn: the protected
      // partition keeps denying, proving no role was assumed.
      expect(
        validateReadPermission(at('active/shared/tmp/confidential/acme-corp/x.png')).allowed
      ).toBe(false);
    });
  });

  it('still refuses other tenants, untenanted shared, knowledge, runtime and artifact floors', async () => {
    await withPerceptionMediaRole({ tier: 'confidential', tenant_slug: TENANT }, () => {
      for (const relative of [
        'active/shared/tmp/confidential/other-co/perception/x/a.png',
        'active/shared/staging/confidential/other-co/inbound/a.png',
        'active/shared/tmp/personal/other-co/perception/x/a.png',
        'active/shared/tmp/confidential/shared/perception/x/a.png',
        'knowledge/confidential/acme-corp/notes.md',
        'knowledge/personal/tenants/acme-corp.json',
        'active/shared/runtime/tenant-ledger/confidential/acme-corp/x.json',
        'active/shared/artifacts/confidential/acme-corp/x.json',
      ]) {
        expect(validateReadPermission(at(relative)).allowed, relative).toBe(false);
      }
    });
  });

  it('throws on an unbound or foreign-tenant assumption', async () => {
    await expect(
      withPerceptionMediaRole({ tier: 'confidential' }, async () => 'unreachable')
    ).rejects.toThrow(/ROLE_TENANT_SCOPE_REQUIRED/);
    await expect(
      withPerceptionMediaRole(
        { tier: 'confidential', tenant_slug: 'other-co' },
        async () => 'unreachable'
      )
    ).rejects.toThrow(/ROLE_TENANT_SCOPE_MISMATCH/);
  });
});

describe('transcribeMediaFile under a persisted confidential tenant scope', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KYBERION_TIER = 'confidential';
    process.env.KYBERION_TENANT = TENANT;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('sniffs and transcribes an input staged on a protected floor', async () => {
    const staged = at(`active/shared/staging/confidential/${TENANT}/listen-${randomUUID()}`);
    safeMkdir(staged, { recursive: true });
    const input = path.join(staged, 'memo.wav');
    safeWriteFile(input, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(16)]));
    // Before-state: the grant-less interactive identity cannot read the
    // signature — the sniff sees the file as unrecognizable media.
    expect(sniffMediaSignature(input)).toBe(false);
    const workDir = createPerceptionWorkDir('listen', input);
    try {
      const heard = await transcribeMediaFile(
        createFakeDeps({ bridges: [guardedReadBridge('guarded-stt')] }),
        'listen',
        input,
        workDir,
        { timestamps: false }
      );
      expect(heard.text).toBe('hello world');
    } finally {
      safeRmSync(workDir, { recursive: true, force: true });
      safeRmSync(staged, { recursive: true, force: true });
    }
  });

  it('runs the full listen command on a staged protected-floor input', async () => {
    const staged = at(`active/shared/staging/confidential/${TENANT}/listen-${randomUUID()}`);
    safeMkdir(staged, { recursive: true });
    const input = path.join(staged, 'memo.wav');
    safeWriteFile(input, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(16)]));
    try {
      // Before-state: assertPerceptionInput's guarded byte read denies the
      // grant-less interactive identity outright.
      expect(() => safeLstat(input)).toThrow(/ROLE_VIOLATION/);
      const result = await runListenCommand(
        [input],
        () => {},
        createFakeDeps({ bridges: [guardedReadBridge('guarded-stt')] })
      );
      expect(result?.text).toBe('hello world');
    } finally {
      safeRmSync(staged, { recursive: true, force: true });
    }
  });
});

describe('transcribeWav under a public scope', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('transcribes an unprotected tmp scratch without any assumption', async () => {
    const workDir = path.join(pathResolver.sharedTmp(`listen-${randomUUID()}`), 'perception');
    safeMkdir(workDir, { recursive: true });
    const wav = path.join(workDir, 'audio-16k-mono.wav');
    safeWriteFile(wav, Buffer.from('RIFF'));
    try {
      const outcome = await transcribeWav(
        createFakeDeps({ bridges: [fakeBridge('fake-stt', { text: 'public ok' })] }),
        wav,
        workDir,
        {}
      );
      expect(outcome.result.text).toBe('public ok');
    } finally {
      safeRmSync(path.dirname(workDir), { recursive: true, force: true });
    }
  });
});

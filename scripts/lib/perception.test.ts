import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { safeLstat, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import type { SpeechToTextBridge } from '@agent/core/voice/speech-to-text-bridge';
import { transcribeWav, createPerceptionWorkDir } from './perception.js';
import { createFakeDeps, fakeBridge } from './perception.test-support.js';

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

/** A bridge that performs the same guarded read the real adapters do. */
function guardedReadBridge(name: string, alsoRead?: string): SpeechToTextBridge {
  return {
    name,
    priority: 10,
    capabilities: { timestamps: false, granularity: 'none', local_only: true },
    async transcribe(input) {
      // The whisperkit/shell adapters lstat the wav (and hash it) inside the
      // bridge call — reproduce that guarded read exactly.
      safeLstat(input.audioPath);
      if (alsoRead) safeLstat(alsoRead);
      return {
        text: 'hello world',
        backend: name,
        language: input.language ?? 'en',
        written_to: input.outputPath ?? path.join(path.dirname(input.audioPath), 'x.txt'),
      };
    },
  };
}

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

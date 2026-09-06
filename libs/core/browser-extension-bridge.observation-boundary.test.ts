import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeWriteFile } from './secure-io.js';
import {
  loadBrowserExtensionObservations,
  persistBrowserExtensionObservation,
} from './browser-extension-bridge.js';

describe('browser-extension observation resource boundary', () => {
  const procedureId = `boundary-observation-${process.pid}`;
  const store = pathResolver.knowledge('personal/browser-observations');
  const link = path.join(store, `${procedureId}.jsonl`);
  const target = pathResolver.sharedTmp(`${procedureId}.jsonl`);

  afterEach(() => {
    fs.rmSync(link, { force: true });
    fs.rmSync(target, { force: true });
  });

  it('does not read or append an observation file reached through a symlink', () => {
    fs.mkdirSync(store, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);

    const observation = {
      schema_version: 'browser-observation.v1',
      observation_id: 'OBS-BOUNDARY',
      procedure_id: procedureId,
      recording_id: 'REC-BOUNDARY',
      lease_id: 'LEASE-BOUNDARY',
      origin: 'https://example.com',
      captured_at: '2026-09-01T00:00:00.000Z',
      source: 'chrome-extension',
      fields: [{ name: 'title', text: 'safe observation' }],
    } as const;

    const previousSudo = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      const persisted = persistBrowserExtensionObservation(observation);
      expect(persisted.errors.join('; ')).toContain('[RESOURCE_PATH_SYMLINK]');
      expect(loadBrowserExtensionObservations(procedureId)).toEqual([]);
      expect(fs.readFileSync(target, 'utf8')).toBe('');
    } finally {
      if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previousSudo;
    }
  });

  it('loads valid observations and skips malformed JSONL rows', () => {
    const previousSudo = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      safeWriteFile(
        link,
        `${JSON.stringify({
          schema_version: 'browser-observation.v1',
          observation_id: 'OBS-VALID',
          procedure_id: procedureId,
          recording_id: 'REC-VALID',
          lease_id: 'LEASE-VALID',
          origin: 'https://example.com',
          captured_at: '2026-09-01T00:00:00.000Z',
          source: 'chrome-extension',
          fields: [{ name: 'title', text: 'safe observation' }],
        })}\n{\n`,
        { mkdir: true }
      );

      expect(loadBrowserExtensionObservations(procedureId)).toHaveLength(1);
    } finally {
      if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previousSudo;
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeMkdir, safeWriteFile, safeReadFile } from '../secure-io.js';
import { loadActuatorManifestCatalog } from './actuator-manifest-index.js';
import { pathResolver } from '../path-resolver.js';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '../schema-loader.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

vi.mock('../core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  checkActuatorCapabilities,
  checkAllActuatorCapabilities,
  registerCapabilityProbe,
} from './actuator-capability.js';

const TMP_MANIFEST = path.resolve(process.cwd(), 'active/shared/tmp/test-actuator-manifest.json');
const TMP_CATALOG_DIR = path.resolve(process.cwd(), 'active/shared/tmp/test-actuator-capability-catalog');

describe('actuator-capability', () => {
  afterEach(() => {
    if (fs.existsSync(TMP_MANIFEST)) {
      fs.unlinkSync(TMP_MANIFEST);
    }
    if (fs.existsSync(TMP_CATALOG_DIR)) {
      fs.rmSync(TMP_CATALOG_DIR, { recursive: true, force: true });
    }
  });

  describe('checkActuatorCapabilities', () => {
    it('reads manifest and returns capabilities', async () => {
      const manifest = {
        actuator_id: 'test-actuator',
        version: '1.2.3',
        capabilities: [
          { op: 'read' },
          { op: 'write' },
        ],
      };
      fs.writeFileSync(TMP_MANIFEST, JSON.stringify(manifest));

      // Use a unique actuator ID without a registered probe to test fallback path
      const status = await checkActuatorCapabilities('unprobed-actuator', TMP_MANIFEST);

      expect(status.actuatorId).toBe('test-actuator');
      expect(status.version).toBe('1.2.3');
      expect(status.capabilities).toHaveLength(2);
      expect(status.capabilities[0].op).toBe('read');
      expect(status.capabilities[0].available).toBe(true);
      expect(status.checkedAt).toBeTruthy();
    });
  });

  describe('registerCapabilityProbe', () => {
    it('registers and is called during check', async () => {
      const customProbe = vi.fn().mockResolvedValue([
        { op: 'custom-op', available: true, cost: 'free' as const },
      ]);

      registerCapabilityProbe('custom-test-actuator', customProbe);

      const manifest = {
        actuator_id: 'custom-test-actuator',
        version: '0.1.0',
        capabilities: [],
      };
      fs.writeFileSync(TMP_MANIFEST, JSON.stringify(manifest));

      const status = await checkActuatorCapabilities('custom-test-actuator', TMP_MANIFEST);

      expect(customProbe).toHaveBeenCalledOnce();
      expect(status.capabilities).toHaveLength(1);
      expect(status.capabilities[0].op).toBe('custom-op');
      expect(status.capabilities[0].available).toBe(true);
    });
  });

  describe('built-in probes', () => {
    it('browser actuator probe detects playwright presence', async () => {
      // The browser-actuator probe should accept either @playwright/test or playwright-core.
      const manifest = {
        actuator_id: 'browser-actuator',
        version: '1.0.0',
        capabilities: [],
      };
      fs.writeFileSync(TMP_MANIFEST, JSON.stringify(manifest));

      const status = await checkActuatorCapabilities('browser-actuator', TMP_MANIFEST);

      expect(status.capabilities.length).toBeGreaterThan(0);
      expect(status.capabilities[0].op).toBe('pipeline');
      expect(typeof status.capabilities[0].available).toBe('boolean');
    });

    it('media actuator probe returns available: true', async () => {
      const manifest = {
        actuator_id: 'media-actuator',
        version: '1.0.0',
        capabilities: [],
      };
      fs.writeFileSync(TMP_MANIFEST, JSON.stringify(manifest));

      const status = await checkActuatorCapabilities('media-actuator', TMP_MANIFEST);

      expect(status.capabilities.length).toBeGreaterThan(0);
      expect(status.capabilities[0].available).toBe(true);
    });
  });

  describe('catalog order', () => {
    it('sorts discovery results by the global actuator index order', async () => {
      safeMkdir(TMP_CATALOG_DIR, { recursive: true });
      safeMkdir(path.join(TMP_CATALOG_DIR, 'voice-actuator'), { recursive: true });
      safeMkdir(path.join(TMP_CATALOG_DIR, 'browser-actuator'), { recursive: true });

      safeWriteFile(
        path.join(TMP_CATALOG_DIR, 'voice-actuator', 'manifest.json'),
        JSON.stringify({ actuator_id: 'voice-actuator', version: '1.0.0', capabilities: [] }),
      );
      safeWriteFile(
        path.join(TMP_CATALOG_DIR, 'browser-actuator', 'manifest.json'),
        JSON.stringify({ actuator_id: 'browser-actuator', version: '1.0.0', capabilities: [] }),
      );

      const statuses = await checkAllActuatorCapabilities(TMP_CATALOG_DIR);

      expect(statuses.map((status) => status.actuatorId)).toEqual([
        'browser-actuator',
        'voice-actuator',
      ]);
    });
  });

  describe('resilience declarations', () => {
    it('all actuator manifests declare resilience_tier and recovery_policy', () => {
      const catalog = loadActuatorManifestCatalog();
      expect(catalog.length).toBeGreaterThan(0);

      for (const entry of catalog) {
        const manifest = JSON.parse(
          safeReadFile(pathResolver.rootResolve(entry.manifest_path), { encoding: 'utf8' }) as string,
        ) as Record<string, unknown>;
        expect(manifest.resilience_tier, entry.actuatorId).toBeDefined();
        expect(manifest.recovery_policy, entry.actuatorId).toBeDefined();
        expect(typeof manifest.resilience_tier, entry.actuatorId).toBe('string');
        expect(manifest.recovery_policy, entry.actuatorId).toEqual(expect.any(Object));
      }
    });

    it('actuator manifest schema accepts resilience declarations', () => {
      const ajv = new AjvCtor({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.join(process.cwd(), 'schemas/actuator-manifest.schema.json'));
      const manifest = JSON.parse(
        safeReadFile(path.join(process.cwd(), 'libs/actuators/file-actuator/manifest.json'), { encoding: 'utf8' }) as string,
      );
      expect(validate(manifest), JSON.stringify(validate.errors || [])).toBe(true);
    });
  });
});

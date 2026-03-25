import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  checkActuatorCapabilities,
  registerCapabilityProbe,
} from './actuator-capability.js';

const TMP_MANIFEST = path.resolve(process.cwd(), 'active/shared/tmp/test-actuator-manifest.json');

describe('actuator-capability', () => {
  afterEach(() => {
    if (fs.existsSync(TMP_MANIFEST)) {
      fs.unlinkSync(TMP_MANIFEST);
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
      expect(status.capabilities[0].available).toBe(true);
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
});

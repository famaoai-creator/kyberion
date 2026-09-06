import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  loadActuatorOpDiscoveryAtPath,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  pathResolver,
} from './index.js';

const testRoot = pathResolver.sharedTmp(`actuator-op-discovery-${process.pid}`);

afterEach(() => {
  safeRmSync(testRoot, { recursive: true, force: true });
});

describe('actuator operation discovery catalog', () => {
  it('loads the generated catalog through its schema-bound loader', () => {
    const catalog = loadActuatorOpDiscoveryAtPath();

    expect(catalog.v).toBe('1.0.0');
    expect(catalog.actuators).toHaveLength(32);
    expect(catalog.actuators[0]?.ops[0]).toHaveProperty('kind');
  });

  it('rejects an invalid discovery document before projection', () => {
    const filePath = path.join(testRoot, 'discovery.json');
    safeMkdir(testRoot, { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({
        v: '1.0.0',
        actuators: [
          {
            n: 'agent-actuator',
            path: 'libs/actuators/agent-actuator',
            source: 'describeOps',
            ops: [],
            unexpected: true,
          },
        ],
      })
    );

    expect(() => loadActuatorOpDiscoveryAtPath(filePath)).toThrow(/Invalid catalog/);
  });
});

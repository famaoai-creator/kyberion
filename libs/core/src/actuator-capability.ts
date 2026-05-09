/**
 * Dynamic Actuator Capability Contracts
 *
 * Transforms static manifest.json declarations into runtime capability detection,
 * so the orchestrator can determine which actuators are actually usable in the
 * current environment.
 */

import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import * as path from 'path';
import { safeExistsSync, safeReadFile } from '../secure-io.js';
import { loadActuatorManifestCatalog } from './actuator-manifest-index.js';

export interface ActuatorCapability {
  op: string;
  available: boolean;
  reason?: string;              // why unavailable
  prerequisites?: string[];     // what's needed to make it available
  cost?: 'free' | 'api_call' | 'compute_light' | 'compute_intensive';
}

export interface ActuatorStatus {
  actuatorId: string;
  version: string;
  capabilities: ActuatorCapability[];
  checkedAt: string;
}

// Registry of capability probe functions
const capabilityProbes = new Map<string, () => Promise<ActuatorCapability[]>>();
let actuatorCatalogOrderCache: Map<string, number> | null = null;

export function registerCapabilityProbe(
  actuatorId: string,
  probe: () => Promise<ActuatorCapability[]>
) {
  capabilityProbes.set(actuatorId, probe);
}

function loadActuatorCatalogOrder(): Map<string, number> {
  if (actuatorCatalogOrderCache) return actuatorCatalogOrderCache;
  const order = new Map<string, number>();
  try {
    for (const [index, entry] of loadActuatorManifestCatalog().entries()) {
      if (entry?.n) order.set(entry.n, index);
    }
  } catch {
    // Fall back to lexical order when the manifest catalog cannot be loaded.
  }

  actuatorCatalogOrderCache = order;
  return order;
}

function compareActuatorCatalogOrder(left: string, right: string): number {
  const order = loadActuatorCatalogOrder();
  const leftOrder = order.has(left) ? order.get(left)! : Number.POSITIVE_INFINITY;
  const rightOrder = order.has(right) ? order.get(right)! : Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.localeCompare(right);
}

/**
 * Check capabilities for a specific actuator by running environment probes.
 * Each actuator can register a checkFn, or fall back to manifest-based static check.
 */
export async function checkActuatorCapabilities(
  actuatorId: string,
  manifestPath: string
): Promise<ActuatorStatus> {
  // Read manifest
  const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string);
  const capabilities: ActuatorCapability[] = [];

  // Run registered probe if exists
  const probe = capabilityProbes.get(actuatorId);
  if (probe) {
    const probed = await probe();
    capabilities.push(...probed);
  } else {
    // Fallback: mark all manifest capabilities as available (static)
    for (const cap of manifest.capabilities || []) {
      capabilities.push({ op: cap.op, available: true, cost: 'free' });
    }
  }

  return {
    actuatorId: manifest.actuator_id || actuatorId,
    version: manifest.version || '0.0.0',
    capabilities,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Scan all actuators in libs/actuators/ and check their capabilities
 */
export async function checkAllActuatorCapabilities(
  actuatorsDir?: string
): Promise<ActuatorStatus[]> {
  const dir = actuatorsDir ? pathResolver.rootResolve(actuatorsDir) : pathResolver.rootResolve('libs/actuators');
  const results: ActuatorStatus[] = [];

  const catalog = loadActuatorManifestCatalog(dir);
  for (const entry of catalog) {
    try {
      const status = await checkActuatorCapabilities(entry.n, pathResolver.rootResolve(entry.manifest_path));
      results.push(status);
    } catch (e: any) {
      logger.error(`Failed to check ${entry.n}: ${e.message}`);
    }
  }

  return results.sort((left, right) => compareActuatorCatalogOrder(left.actuatorId, right.actuatorId));
}

// ─── Built-in Probes ───────────────────────────────────────────────────────────

// Browser actuator: check if Playwright is installed
registerCapabilityProbe('browser-actuator', async () => {
  try {
    const pwPath = pathResolver.rootResolve('node_modules/playwright-core');
    const pwTestPath = pathResolver.rootResolve('node_modules/@playwright/test');
    const available = safeExistsSync(pwPath) || safeExistsSync(pwTestPath);
    return [{
      op: 'pipeline',
      available,
      reason: available ? undefined : '@playwright/test or playwright-core not installed',
      prerequisites: available ? undefined : ['pnpm add -D @playwright/test', 'npx playwright install chromium'],
    }];
  } catch { return [{ op: 'pipeline', available: false, reason: 'check failed' }]; }
});

// Voice actuator: check if TTS server is reachable
registerCapabilityProbe('voice-actuator', async () => {
  try {
    const { platform } = await import('../platform.js');
    const capabilities = await platform.getCapabilities();
    const available = capabilities.hasSpeech;
    const reason = available ? undefined : 'No native speech binary is available on this host';
    return [
      { op: 'speak_local', available, reason, cost: 'free' },
      { op: 'list_voices', available, reason },
      { op: 'generate_voice', available, reason, cost: 'compute_light' },
    ];
  } catch {
    return [
      { op: 'speak_local', available: false, reason: 'probe failed' },
      { op: 'list_voices', available: false, reason: 'probe failed' },
      { op: 'generate_voice', available: false, reason: 'probe failed' },
    ];
  }
});

// Vision actuator: check platform
registerCapabilityProbe('vision-actuator', async () => {
  const isDarwin = process.platform === 'darwin';
  return [
    { op: 'capture', available: isDarwin, reason: isDarwin ? undefined : 'screencapture requires macOS', prerequisites: isDarwin ? undefined : ['Run on macOS'] },
    { op: 'pipeline', available: isDarwin, reason: isDarwin ? undefined : 'vision pipeline requires macOS screen capture' },
  ];
});

// Media actuator: always available (pure Node.js)
registerCapabilityProbe('media-actuator', async () => [
  { op: 'pipeline', available: true, cost: 'free' },
]);

// System actuator: check shell availability
registerCapabilityProbe('system-actuator', async () => [
  { op: 'exec', available: true, cost: 'free' },
  { op: 'pipeline', available: true, cost: 'free' },
]);

// Gemini CLI: check sub-commands and extensions
registerCapabilityProbe('gemini-cli', async () => {
  const { safeExec } = await import('../secure-io.js');
  try {
    const help = safeExec('gemini', ['--help']);
    return [
      { op: 'prompt', available: help.includes('--prompt'), cost: 'compute_intensive' },
      { op: 'extensions', available: help.includes('extensions'), cost: 'free' },
      { op: 'skills', available: help.includes('skills'), cost: 'free' },
      { op: 'hooks', available: help.includes('hooks'), cost: 'free' },
      { op: 'mcp', available: help.includes('mcp'), cost: 'free' },
    ];
  } catch {
    return [{ op: 'prompt', available: false, reason: 'gemini binary not in PATH' }];
  }
});

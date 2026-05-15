import { logger } from './core.js';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Provider Discovery v1.0
 *
 * Detects which LLM agent providers are installed and available.
 * Results are cached to avoid repeated shell calls.
 *
 * Cache strategy:
 *   1. In-memory (per-process, reset on restart)
 *   2. Disk cache at ~/.kyberion/provider-cache.json (survives process restarts)
 *
 * Note: uses native node:fs intentionally — this is system-level infrastructure,
 * not a mission artifact. secure-io / tier-guard do not govern ~/.kyberion/.
 */

export interface ProviderInfo {
  provider: string;
  installed: boolean;
  version: string | null;
  protocol: 'acp' | 'print-json' | 'exec' | 'json-rpc';
  models: string[];
  capabilities?: string[];
  modelCapabilities?: Record<string, string[]>;
  healthy: boolean;
}

let cachedProviders: ProviderInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 300000; // 5 min

const DISK_CACHE_PATH = path.join(os.homedir(), '.kyberion', 'provider-cache.json');

function readDiskCache(): ProviderInfo[] | null {
  try {
    const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { ts: number; providers: ProviderInfo[] };
    if (Date.now() - parsed.ts < CACHE_TTL) return parsed.providers;
  } catch { /* cache miss — non-fatal */ }
  return null;
}

function writeDiskCache(providers: ProviderInfo[]): void {
  try {
    const dir = path.dirname(DISK_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify({ ts: Date.now(), providers }), 'utf8');
  } catch { /* non-fatal */ }
}

function run(cmd: string, args: string[], timeoutMs = 10000): { ok: boolean; stdout: string } {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
      shell: false,
    });
    return { ok: res.status === 0, stdout: (res.stdout || '').trim() };
  } catch (_) {
    return { ok: false, stdout: '' };
  }
}

function checkGemini(): ProviderInfo {
  const which = run('which', ['gemini']);
  if (!which.ok) return { provider: 'gemini', installed: false, version: null, protocol: 'acp', models: [], healthy: false };

  const ver = run('gemini', ['--version']);
  return {
    provider: 'gemini',
    installed: true,
    version: ver.stdout || null,
    protocol: 'acp',
    models: [
      'auto-gemini-3', 'auto-gemini-2.5',
      'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    ],
    capabilities: [
      'reasoning',
      'planning',
      'coordination',
      'analysis',
      'code',
      'review',
      'architecture',
      'a2a',
      'structured_json',
      'surface',
      'conversation',
      'realtime',
      'low_latency',
      'routing',
      'delegation',
      'dashboard',
      'a2ui',
    ],
    modelCapabilities: {
      'auto-gemini-3': ['reasoning', 'planning', 'coordination', 'analysis', 'structured_json', 'code', 'review', 'architecture', 'a2a'],
      'auto-gemini-2.5': ['reasoning', 'planning', 'coordination', 'analysis', 'structured_json', 'low_latency', 'code', 'review', 'architecture', 'a2a'],
      'gemini-3.1-pro-preview': ['reasoning', 'planning', 'analysis', 'structured_json', 'long_context', 'code', 'review', 'architecture'],
      'gemini-3-flash-preview': ['low_latency', 'conversation', 'structured_json', 'surface'],
      'gemini-2.5-pro': ['reasoning', 'planning', 'analysis', 'structured_json', 'long_context', 'a2a', 'code', 'review', 'architecture'],
      'gemini-2.5-flash': ['structured_json', 'surface', 'conversation', 'realtime', 'low_latency', 'routing', 'delegation', 'dashboard', 'a2ui', 'slack', 'presence', 'onboarding', 'gateway'],
      'gemini-2.5-flash-lite': ['structured_json', 'conversation', 'low_latency', 'surface', 'slack'],
    },
    healthy: true,
  };
}

function checkClaude(): ProviderInfo {
  const which = run('which', ['claude']);
  if (!which.ok) return { provider: 'claude', installed: false, version: null, protocol: 'print-json', models: [], healthy: false };

  // Use --version only — probeShellClaudeCliAvailability() makes a live LLM call
  // which is too expensive for discovery. Credential validity is checked at use-time.
  const ver = run('claude', ['--version']);
  return {
    provider: 'claude',
    installed: true,
    version: ver.ok ? (ver.stdout || null) : null,
    protocol: 'print-json',
    models: [
      'sonnet', 'opus', 'haiku',
      'claude-sonnet-4-6', 'claude-opus-4-6',
      'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001',
    ],
    capabilities: [
      'reasoning',
      'planning',
      'coordination',
      'analysis',
      'review',
      'code',
      'long_context',
      'structured_json',
    ],
    modelCapabilities: {
      sonnet: ['reasoning', 'planning', 'coordination', 'analysis', 'review', 'code', 'long_context', 'structured_json'],
      opus: ['reasoning', 'planning', 'coordination', 'analysis', 'review', 'code', 'long_context', 'structured_json', 'deep_reasoning'],
      haiku: ['conversation', 'summarization', 'low_latency', 'structured_json'],
      'claude-sonnet-4-6': ['reasoning', 'analysis', 'review', 'code', 'long_context', 'structured_json'],
      'claude-opus-4-6': ['reasoning', 'analysis', 'review', 'code', 'long_context', 'structured_json', 'deep_reasoning'],
      'claude-sonnet-4-20250514': ['reasoning', 'analysis', 'review', 'code', 'long_context', 'structured_json'],
      'claude-haiku-4-5-20251001': ['conversation', 'summarization', 'low_latency', 'structured_json'],
    },
    healthy: ver.ok,
  };
}

function checkCopilot(): ProviderInfo {
  // Check if gh copilot is available (--help is more reliable than --version)
  const help = run('gh', ['copilot', '--', '--help'], 15000);
  if (!help.ok) return { provider: 'copilot', installed: false, version: null, protocol: 'acp', models: [], healthy: false };

  return {
    provider: 'copilot',
    installed: true,
    version: 'available',
    protocol: 'acp',
    models: [
      'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-sonnet-4',
      'claude-opus-4.6', 'claude-opus-4.6-fast', 'claude-opus-4.5',
      'claude-haiku-4.5',
      'gemini-3-pro-preview',
      'gpt-5.4', 'gpt-5.3-codex',
    ],
    capabilities: ['code', 'implementation', 'refactoring', 'review', 'reasoning', 'structured_json'],
    modelCapabilities: {
      'claude-sonnet-4.6': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-sonnet-4.5': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-sonnet-4': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-opus-4.6': ['reasoning', 'analysis', 'review', 'code', 'structured_json', 'deep_reasoning'],
      'claude-opus-4.6-fast': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-opus-4.5': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-haiku-4.5': ['conversation', 'summarization', 'low_latency', 'structured_json'],
      'gemini-3-pro-preview': ['reasoning', 'planning', 'analysis', 'structured_json'],
      'gpt-5.4': ['code', 'implementation', 'refactoring', 'review', 'reasoning', 'structured_json'],
      'gpt-5.3-codex': ['code', 'implementation', 'refactoring', 'review', 'reasoning', 'structured_json'],
    },
    healthy: true,
  };
}

function checkCodex(): ProviderInfo {
  const which = run('which', ['codex']);
  const installed = which.ok;
  const mode = (process.env.KYBERION_CODEX_MODE || 'app-server').toLowerCase();
  const protocol: ProviderInfo['protocol'] = (mode === 'exec' || mode === 'legacy') ? 'exec' : 'json-rpc';

  return {
    provider: 'codex',
    installed,
    version: null,
    protocol,
    models: ['codex'],
    capabilities: ['code', 'implementation', 'refactoring', 'patch', 'terminal', 'debugging', 'structured_json'],
    modelCapabilities: {
      codex: ['code', 'implementation', 'refactoring', 'patch', 'terminal', 'debugging', 'structured_json'],
    },
    healthy: installed,
  };
}

/**
 * Discover all available providers. Cached for 5 minutes.
 */
export function discoverProviders(forceRefresh = false): ProviderInfo[] {
  // 1. In-memory cache
  if (!forceRefresh && cachedProviders && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return cachedProviders;
  }

  // 2. Disk cache (survives process restarts — avoids re-probing on every pipeline run)
  if (!forceRefresh) {
    const disk = readDiskCache();
    if (disk) {
      cachedProviders = disk;
      cacheTimestamp = Date.now();
      logger.info(`[PROVIDER_DISCOVERY] Loaded from cache: ${disk.filter(p => p.installed).map(p => p.provider).join(', ')}`);
      return disk;
    }
  }

  // 3. Full discovery
  logger.info('[PROVIDER_DISCOVERY] Scanning available providers...');
  const providers = [
    checkGemini(),
    checkClaude(),
    checkCopilot(),
    checkCodex(),
  ];

  const available = providers.filter(p => p.installed);
  logger.info(`[PROVIDER_DISCOVERY] Found ${available.length}/${providers.length}: ${available.map(p => p.provider).join(', ')}`);

  cachedProviders = providers;
  cacheTimestamp = Date.now();
  writeDiskCache(providers);
  return providers;
}

export function refreshProviderDiscoveryCache(): ProviderInfo[] {
  return discoverProviders(true);
}

export function clearProviderDiscoveryCache(): void {
  cachedProviders = null;
  cacheTimestamp = 0;
  try { fs.unlinkSync(DISK_CACHE_PATH); } catch { /* non-fatal */ }
}

/**
 * Get only installed providers.
 */
export function getAvailableProviders(): ProviderInfo[] {
  return discoverProviders().filter(p => p.installed);
}

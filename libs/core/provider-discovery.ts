import { logger } from './core.js';
import { spawnSync } from 'node:child_process';

/**
 * Provider Discovery v1.0
 *
 * Detects which LLM agent providers are installed and available.
 * Results are cached to avoid repeated shell calls.
 */

export interface ProviderInfo {
  provider: string;
  installed: boolean;
  version: string | null;
  protocol: 'acp' | 'print-json' | 'exec' | 'json-rpc';
  models: string[];
  healthy: boolean;
}

let cachedProviders: ProviderInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 300000; // 5 min

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
    healthy: true,
  };
}

function checkClaude(): ProviderInfo {
  const which = run('which', ['claude']);
  if (!which.ok) return { provider: 'claude', installed: false, version: null, protocol: 'print-json', models: [], healthy: false };

  const ver = run('claude', ['--version']);
  return {
    provider: 'claude',
    installed: true,
    version: ver.stdout || null,
    protocol: 'print-json',
    models: [
      'sonnet', 'opus', 'haiku',
      'claude-sonnet-4-6', 'claude-opus-4-6',
      'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001',
    ],
    healthy: true,
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
    healthy: true,
  };
}

function checkCodex(): ProviderInfo {
  const which = run('which', ['codex']);
  const npx = !which.ok ? run('npx', ['codex', '--version'], 15000) : { ok: true, stdout: '' };
  const installed = which.ok || npx.ok;
  const mode = (process.env.KYBERION_CODEX_MODE || 'app-server').toLowerCase();
  const protocol: ProviderInfo['protocol'] = (mode === 'exec' || mode === 'legacy') ? 'exec' : 'json-rpc';

  return {
    provider: 'codex',
    installed,
    version: which.ok ? null : (npx.stdout || null),
    protocol,
    models: ['codex'],
    healthy: installed,
  };
}

/**
 * Discover all available providers. Cached for 5 minutes.
 */
export function discoverProviders(forceRefresh = false): ProviderInfo[] {
  if (!forceRefresh && cachedProviders && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return cachedProviders;
  }

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
  return providers;
}

/**
 * Get only installed providers.
 */
export function getAvailableProviders(): ProviderInfo[] {
  return discoverProviders().filter(p => p.installed);
}

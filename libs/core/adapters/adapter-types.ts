/**
 * libs/core/adapters/adapter-types.ts
 * Shared types and utilities for all agent adapters.
 */

import { safeExistsSync } from '../secure-io.js';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';

export interface AgentResponse {
  text: string;
  thought?: string;
  stopReason: string;
}

export interface AgentAdapter {
  boot(): Promise<void>;
  ask(prompt: string): Promise<AgentResponse>;
  shutdown(): Promise<void>;
  getRuntimeInfo?(): Record<string, unknown>;
  refreshContext?(): Promise<{ mode: 'soft' | 'stateless'; sessionId?: string | null; threadId?: string | null }>;
}

const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'NODE_ENV',
  'NVM_DIR', 'NVM_BIN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MISSION_ID', 'MISSION_ROLE', 'KYBERION_PERSONA',
  'CODEX_HOME',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

export function safeEnv(): Record<string, string> {
  const env: Record<string, string> = { FORCE_COLOR: '0', TERM: 'dumb' };
  for (const k of ENV_WHITELIST) { if (process.env[k]) env[k] = process.env[k] as string; }
  return env;
}

export function resolveProjectRoot(): string {
  return pathResolver.rootDir();
}

export function extractUsageSummary(payload: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const usage = (current as any).usage;
    if (usage && typeof usage === 'object') {
      return usage as Record<string, unknown>;
    }
    for (const value of Object.values(current as Record<string, unknown>)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

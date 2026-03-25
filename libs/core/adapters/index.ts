/**
 * libs/core/adapters/index.ts
 * Unified entry point for all agent adapters.
 * Consumers can import from '@agent/core/adapters' for a scoped surface area.
 */

export type { AgentAdapter, AgentResponse } from './adapter-types.js';
export { safeEnv, resolveProjectRoot, extractUsageSummary } from './adapter-types.js';
export { GeminiAdapter } from './gemini-adapter.js';
export { CodexAdapter, CodexAppServerAdapter } from './codex-adapter.js';
export { ClaudeAdapter } from './claude-adapter.js';
export type { ClaudeAdapterOptions } from './claude-adapter.js';
export { AgentFactory } from './agent-factory.js';

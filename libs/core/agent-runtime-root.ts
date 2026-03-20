import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';

export type AgentWorkspaceMode = 'conversation' | 'mission' | 'operator' | 'default';

export interface AgentRuntimeRootOptions {
  agentId: string;
  provider: string;
  mode: AgentWorkspaceMode;
  channel?: string;
  thread?: string;
  missionId?: string;
  systemPrompt?: string;
}

function providerMemoryFile(provider: string): string | null {
  switch (provider) {
    case 'gemini':
      return 'GEMINI.md';
    case 'claude':
      return 'CLAUDE.md';
    case 'codex':
      return 'CODEX.md';
    default:
      return null;
  }
}

function buildProjectedMemory(options: AgentRuntimeRootOptions): string {
  if (options.mode === 'conversation') {
    const lines = [
      `# ${options.agentId} Conversation Runtime`,
      '',
      `Mode: ${options.mode}`,
      `Provider: ${options.provider}`,
      '',
      'This directory is an isolated Kyberion conversation runtime root.',
      'Treat only the current request and explicitly projected context as available input.',
      'Do not assume repository structure, product history, or broader project documents.',
      '',
      'Conversation-mode constraints:',
      '- Reply directly in the user language.',
      '- Ask a short clarification question if information is missing.',
      '- Do not create files, start implementation, or begin mission work.',
      '- Do not inspect parent directories or infer hidden project context.',
      '- If execution is needed, propose it explicitly instead of acting on it.',
    ];

    return `${lines.join('\n')}\n`;
  }

  const lines = [
    `# ${options.agentId} Runtime Root`,
    '',
    `Mode: ${options.mode}`,
    `Provider: ${options.provider}`,
    '',
    'This directory is an isolated Kyberion runtime root.',
    'Treat this directory as the full available workspace context.',
    'Do not assume broader repository files, project history, or provider memory outside this directory.',
  ];

  if (options.systemPrompt) {
    lines.push(
      '',
      'Projected role guidance:',
      options.systemPrompt.trim(),
    );
  }

  return `${lines.join('\n')}\n`;
}

export function ensureAgentRuntimeRoot(options: AgentRuntimeRootOptions): string {
  const base = pathResolver.sharedTmp('agent-runtime-roots');
  safeMkdir(base, { recursive: true });

  const parts: string[] = [options.mode];
  if (options.channel) parts.push(options.channel.replace(/[^\w.-]+/g, '_'));
  if (options.thread) parts.push(options.thread.replace(/[^\w.-]+/g, '_'));
  if (options.missionId) parts.push(options.missionId.replace(/[^\w.-]+/g, '_'));
  parts.push(options.agentId.replace(/[^\w.-]+/g, '_'));

  const root = path.join(base, ...parts);
  safeMkdir(root, { recursive: true });

  const memoryFile = providerMemoryFile(options.provider);
  if (memoryFile) {
    safeWriteFile(path.join(root, memoryFile), buildProjectedMemory(options));
  }

  return root;
}

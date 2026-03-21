import { logger, ptyEngine, encodeTerminalInput, createStandardYargs, safeReadFile } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Terminal-Actuator v0.2.0 [PROTOTYPE]
 * Provides virtual terminal sessions via PTY engine with Symbolic Keys and Log Slicing.
 */

interface TerminalAction {
  action: 'spawn' | 'poll' | 'write' | 'kill' | 'list' | 'resize';
  params: {
    sessionId?: string;
    threadId?: string; // Logical thread identifier for re-attachment
    persona?: string; // e.g. "KYBERION-PRIME"
    shell?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    data?: string;
    keys?: string[]; // Symbolic keys (e.g. ["Ctrl-C", "Enter"])
    cols?: number;
    rows?: number;
    offset?: number; // For log slicing
    limit?: number; // For log slicing
  };
}

interface TerminalResult {
  status?: string;
  sessionId?: string;
  success?: boolean;
  sessions?: any[];
  messages?: any[];
  exitCode?: number;
  output?: string;
  nextOffset?: number;
  total?: number;
  [key: string]: any;
}

export async function handleAction(input: TerminalAction): Promise<TerminalResult> {
  const { action, params } = input;
  const rootDir = process.cwd();

  switch (action) {
    case 'spawn': {
      const shell = params.shell || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
      const args = params.args || [];
      const cwd = params.cwd ? path.resolve(rootDir, params.cwd) : rootDir;
      const sessionId = ptyEngine.spawn(shell, args, cwd, params.env || {}, params.threadId);
      return { status: 'created', sessionId };
    }

    case 'poll': {
      if (!params.sessionId) throw new Error('sessionId is required for poll action');
      const result = ptyEngine.poll(params.sessionId, params.offset, params.limit);

      // Also fetch messages for the specific persona if threadId is known
      let messages: any[] = [];
      if (params.threadId && params.persona) {
        messages = ptyEngine.popMessages(params.threadId, params.persona);
      }

      const session = ptyEngine.get(params.sessionId);
      return {
        status: session?.status || 'unknown',
        ...result,
        messages,
        exitCode: session?.exitCode
      };
    }

    case 'write': {
      if (!params.sessionId) throw new Error('sessionId is required for write action');

      let dataToWrite = '';
      if (params.keys) {
        dataToWrite = encodeTerminalInput(params.keys);
      } else if (params.data !== undefined) {
        dataToWrite = params.data;
      } else {
        throw new Error('data or keys is required for write action');
      }

      const success = ptyEngine.write(params.sessionId, dataToWrite);
      return { success };
    }

    case 'resize': {
      if (!params.sessionId) throw new Error('sessionId is required for resize action');
      if (params.cols === undefined || params.rows === undefined) {
        throw new Error('cols and rows are required for resize action');
      }
      const success = ptyEngine.resize(params.sessionId, params.cols, params.rows);
      return { success };
    }

    case 'kill': {
      if (!params.sessionId) throw new Error('sessionId is required for kill action');
      const success = ptyEngine.kill(params.sessionId);
      return { success };
    }

    case 'list': {
      return { sessions: ptyEngine.list() };
    }

    default:
      throw new Error(`Unsupported terminal action: ${action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  
  const inputPath = path.resolve(process.cwd(), argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { createLogger } from './logger.js';

const logger = createLogger('terminal-bridge');

/**
 * Terminal Bridge v4.0 (Isolated Session Protocol)
 * Uses file-based I/O at active/shared/runtime/terminal/{sessionId}/
 */

const RUNTIME_BASE = pathResolver.shared('runtime/terminal');
const TERMINAL_SESSION_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/terminal-session-state.schema.json'
);
const TERMINAL_RESPONSE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/terminal-response.schema.json'
);

export interface TerminalSessionState {
  pid: number;
  status?: string;
}

interface TerminalResponse {
  data?: {
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function pathSegment(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/u.test(normalized)) {
    throw new Error(`[terminal-bridge] invalid ${label}`);
  }
  return normalized;
}

function runtimePath(sessionId: string, ...parts: string[]): string {
  const session = pathSegment(sessionId, 'session id');
  const candidate = path.join(
    RUNTIME_BASE,
    session,
    ...parts.map((part) => pathSegment(part, 'path segment'))
  );
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

function terminalSessionStateCatalogAtPath(filePath: string) {
  return defineCatalog<TerminalSessionState>({
    id: 'terminal-session-state',
    path: filePath,
    schema: TERMINAL_SESSION_STATE_SCHEMA_PATH,
  });
}

function terminalResponseCatalogAtPath(filePath: string) {
  return defineCatalog<TerminalResponse>({
    id: 'terminal-response',
    path: filePath,
    schema: TERMINAL_RESPONSE_SCHEMA_PATH,
  });
}

/** Load a ReflexTerminal state only after repository and regular-file checks. */
export function loadTerminalSessionStateAtPath(filePath: string): TerminalSessionState | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return terminalSessionStateCatalogAtPath(safePath).load();
  } catch {
    return null;
  }
}

/** Load the latest ReflexTerminal response through the governed catalog. */
function loadTerminalResponseAtPath(filePath: string): TerminalResponse | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return terminalResponseCatalogAtPath(safePath).load();
  } catch {
    return null;
  }
}

function listReflexTerminalSessions() {
  if (!safeExistsSync(RUNTIME_BASE)) return [];
  const sessions: Array<{
    winId: string;
    sessionId: string;
    type: string;
    status?: string;
    pid?: number;
  }> = [];
  for (const id of safeReaddir(RUNTIME_BASE)) {
    let stateFile: string;
    try {
      stateFile = runtimePath(id, 'state.json');
    } catch {
      continue;
    }
    if (!safeExistsSync(stateFile)) continue;
    const state = loadTerminalSessionStateAtPath(stateFile);
    if (state) {
      process.kill(state.pid, 0);
      sessions.push({
        winId: 'rt-main',
        sessionId: id,
        type: 'ReflexTerminal',
        status: state.status || 'running',
        pid: state.pid,
      });
    }
  }
  return sessions;
}

const STRATEGIES: Record<string, any> = {
  ReflexTerminal: {
    findIdle: () => {
      if (!safeExistsSync(RUNTIME_BASE)) return null;

      const sessions = safeReaddir(RUNTIME_BASE);
      for (const id of sessions) {
        let stateFile: string;
        try {
          stateFile = runtimePath(id, 'state.json');
        } catch {
          continue;
        }
        if (safeExistsSync(stateFile)) {
          const state = loadTerminalSessionStateAtPath(stateFile);
          if (state) {
            // Simple check if the process is still alive
            process.kill(state.pid, 0);
            return { winId: 'rt-main', sessionId: id, type: 'ReflexTerminal' };
          }
        }
      }
      return null;
    },
    inject: async (winId: string, sessionId: string, text: string) => {
      const sid = sessionId || 'default';
      let sessionInDir: string;
      try {
        sessionInDir = runtimePath(sid, 'in');
      } catch (err: any) {
        logger.error(`file injection failed for ${sid}: ${err.message}`);
        return false;
      }

      try {
        if (!safeExistsSync(sessionInDir)) {
          safeMkdir(sessionInDir, { recursive: true });
        }

        const requestId = `req-${Date.now()}`;
        const requestPath = assertSafeRepositoryPath(path.join(sessionInDir, `${requestId}.json`), {
          allowMissingLeaf: true,
        });

        safeWriteFile(
          requestPath,
          JSON.stringify(
            {
              id: requestId,
              ts: nowIso(),
              text,
            },
            null,
            2
          )
        );

        return true;
      } catch (err: any) {
        logger.error(`file injection failed for ${sid}: ${err.message}`);
        return false;
      }
    },
  },
  iTerm2: {
    findIdle: () => {
      const script = `
        tell application "iTerm2"
          if not (exists windows) then return "NOT_FOUND"
          set bestSession to "NOT_FOUND"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                try
                  set conts to contents of s
                  if conts contains "Gemini" then
                    set bestSession to (id of w as string) & ":" & (unique ID of s as string)
                    exit repeat
                  end if
                end try
              end repeat
              if bestSession is not "NOT_FOUND" then exit repeat
            end repeat
            if bestSession is not "NOT_FOUND" then exit repeat
          end repeat
          if bestSession is "NOT_FOUND" then
            try
              set w to front window
              set t to current tab of w
              set s to current session of t
              set bestSession to (id of w as string) & ":" & (unique ID of s as string)
            on error
              return "NOT_FOUND"
            end try
          end if
          return bestSession
        end tell
      `;
      try {
        const result = safeExec('osascript', ['-e', script]).trim();
        if (result === 'NOT_FOUND' || !result.includes(':')) return null;
        const [winId, sessionId] = result.split(':');
        return { winId, sessionId, type: 'iTerm2' };
      } catch (_) {
        return null;
      }
    },
    inject: async (winId: string, sessionId: string, text: string) => {
      const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      const script = `
        tell application "iTerm2"
          try
            repeat with w in windows
              repeat with t in tabs of w
                repeat with s in sessions of t
                  if (unique ID of s as string) is "${sessionId}" then
                    tell s
                      write text "${escapedText}"
                    end tell
                    tell application "System Events" to key code 36
                    return "SUCCESS"
                  end if
                end repeat
              end repeat
            end repeat
          on error errText
            return "ERROR: " & errText
          end try
          return "SESSION_NOT_FOUND"
        end tell
      `;
      try {
        const result = safeExec('osascript', ['-e', script]).trim();
        return result === 'SUCCESS';
      } catch (_) {
        return false;
      }
    },
  },
};

export const terminalBridge = {
  findIdleSession: () => {
    const rt = STRATEGIES.ReflexTerminal.findIdle();
    if (rt) return rt;
    const iterm = STRATEGIES.iTerm2.findIdle();
    if (iterm) return iterm;
    return null;
  },
  listTargets: () => {
    const reflexSessions = listReflexTerminalSessions();
    const iTermIdle = STRATEGIES.iTerm2.findIdle();
    return [
      {
        application: 'Terminal',
        adapter: 'terminal',
        sessions: reflexSessions,
        idleSession: reflexSessions[0] || null,
      },
      {
        application: 'iTerm2',
        adapter: 'iterm2',
        sessions: iTermIdle ? [iTermIdle] : [],
        idleSession: iTermIdle,
      },
    ];
  },
  injectAndExecute: async (
    winId: string,
    sessionId: string,
    text: string,
    terminalType = 'iTerm2'
  ) => {
    const strategy = STRATEGIES[terminalType];
    if (!strategy) throw new Error(`Unsupported terminal strategy: ${terminalType}`);
    return await strategy.inject(winId, sessionId, text);
  },
  readLatestOutput: (winId: string, sessionId: string, terminalType = 'iTerm2'): string => {
    if (terminalType === 'ReflexTerminal') {
      let latestPath: string;
      try {
        latestPath = runtimePath(sessionId, 'out', 'latest_response.json');
      } catch {
        return '';
      }
      if (safeExistsSync(latestPath)) {
        return loadTerminalResponseAtPath(latestPath)?.data?.message || '';
      }
      return '';
    }
    // Fallback for iTerm2
    return '';
  },
};

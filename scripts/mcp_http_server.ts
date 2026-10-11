/** Default-off HTTP MCP entrypoint; never starts on import or validation. */
import { createMcpHttpRuntime } from '@agent/shared-network';
import { loadHumanRequestRuntimeConfig } from '@agent/core/surface/human-request-runtime-config';
import {
  defineScript,
  isDirectScript,
  stripSharedScriptFlags,
  type ScriptContext,
} from './lib/harness.js';

export async function runMcpHttpServerCommand(context: ScriptContext) {
  const args = stripSharedScriptFlags(context.argv);
  let start = false;
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--start' && !start) start = true;
    else if (
      arg === '--config' &&
      configPath === undefined &&
      args[index + 1] &&
      !args[index + 1].startsWith('-')
    )
      configPath = args[++index];
    else throw new Error('Use --check or --start with optional --config path');
  }
  if (!start && !context.check && !context.dryRun)
    throw new Error('Use --check or --start with optional --config path');
  const runtime = createMcpHttpRuntime(loadHumanRequestRuntimeConfig(configPath));
  // Validation always wins, even if --start was also supplied.
  if (context.check || context.dryRun) {
    const result = {
      operation: 'mcp-http.validate',
      enabled: runtime.enabled,
      listening: false,
      external_tls_verified: false,
      provider_verified: false,
    };
    context.print(result);
    return result;
  }
  const handle = await runtime.start();
  const stop = () => {
    void handle.close().catch(() => undefined);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    context.print({
      operation: 'mcp-http.start',
      listening: true,
      transport: 'loopback-reverse-proxy',
      external_tls_verified: false,
      provider_verified: false,
    });
    if ((await handle.closed) === 'failed') throw new Error('HTTP MCP listener failed');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await handle.close();
  }
}

export const runMcpHttpServer = defineScript({ name: 'mcp:http', run: runMcpHttpServerCommand });
if (
  isDirectScript(import.meta.url, 'mcp_http_server.ts') ||
  isDirectScript(import.meta.url, 'mcp_http_server.js')
)
  void runMcpHttpServer();

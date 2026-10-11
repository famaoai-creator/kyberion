/** Explicit, default-off HTTP composition. External HTTPS termination is operator-owned. */
import express, { type Express } from 'express';
import { createServer } from 'node:http';
import {
  parseHumanRequestRuntimeConfig,
  type HumanRequestRuntimeConfig,
} from '@agent/core/surface/human-request-runtime-config';
import {
  createMcpHttpResourceServer,
  type McpHttpResourceServerDependencies,
} from './mcp-http-resource-server.js';

export interface McpHttpRuntimeHandle {
  close(): Promise<void>;
  closed: Promise<'closed' | 'failed'>;
}
export interface McpHttpRuntime {
  app: Express;
  enabled: boolean;
  start(): Promise<McpHttpRuntimeHandle>;
}

/** Composition validates crypto locally and mounts PRM and resource at the application root. */
export function createMcpHttpRuntime(
  config: HumanRequestRuntimeConfig = { version: 1 },
  dependencies: McpHttpResourceServerDependencies = {}
): McpHttpRuntime {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  let snapshot: HumanRequestRuntimeConfig;
  try {
    snapshot = parseHumanRequestRuntimeConfig(config);
    const http = snapshot.httpMcp;
    if (http?.enabled === true) {
      if (!snapshot.policy || !http.token) throw new Error();
      app.use(
        createMcpHttpResourceServer(
          {
            enabled: true,
            token: http.token,
            policy: snapshot.policy,
            allowedOrigins: http.allowedOrigins,
          },
          dependencies
        )
      );
    }
  } catch {
    throw new Error('Invalid HTTP MCP runtime configuration');
  }
  let started = false;
  return {
    app,
    enabled: snapshot.httpMcp?.enabled === true,
    async start() {
      const http = snapshot.httpMcp;
      if (started || http?.enabled !== true || !http.deployment)
        throw new Error('HTTP MCP start requires enabled configuration and loopback deployment');
      started = true;
      const server = createServer(app);
      let finish: (status: 'closed' | 'failed') => void;
      const closed = new Promise<'closed' | 'failed'>((resolve) => {
        finish = resolve;
      });
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(new Error('HTTP MCP shutdown failed'));
            else resolve();
          });
          server.closeIdleConnections();
        }));
      server.once('close', () => finish('closed'));
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = () => reject(new Error('HTTP MCP listener failed'));
          server.once('error', onError);
          server.listen({ host: http.deployment!.host, port: http.deployment!.port }, () => {
            server.removeListener('error', onError);
            server.on('error', () => {
              finish('failed');
              void close().catch(() => finish('failed'));
            });
            resolve();
          });
        });
      } catch {
        finish('failed');
        throw new Error('HTTP MCP listener failed');
      }
      return { close, closed };
    },
  };
}

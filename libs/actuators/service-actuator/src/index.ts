import { logger, secretGuard, safeExec } from '@agent/core';
import { secureFetch } from '@agent/core/network';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Service-Actuator v1.1.0 [STREAMING SUPPORTED]
 * Unified Reachability Layer for External SaaS/APIs.
 * Enforces Service-Aware Secret Injection (Least Privilege).
 */

interface ServiceAction {
  service_id: string; // e.g., 'slack', 'jira', 'box'
  mode: 'API' | 'CLI' | 'SDK' | 'STREAM';
  action: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params: any;
  auth?: 'none' | 'secret-guard' | 'session';
}

async function handleAction(input: ServiceAction, onEvent?: (data: any) => void) {
  logger.info(`🔌 [SERVICE] Dispatching to ${input.service_id} (Mode: ${input.mode}, Action: ${input.action})`);

  // 1. Service-Aware Guard: Only allow access to requested service's secrets
  let token: string | null = null;
  if (input.auth === 'secret-guard') {
    const service = input.service_id.toUpperCase();
    token = secretGuard.getSecret(`${service}_BOT_TOKEN`, input.service_id) 
         || secretGuard.getSecret(`${service}_TOKEN`, input.service_id);
    
    if (!token) {
      throw new Error(`Access Denied: No secret found for service "${input.service_id}"`);
    }
    logger.info(`🔐 [AUTH] Securely injected credentials for ${input.service_id}`);
  }

  // 2. Multi-Mode Execution
  switch (input.mode) {
    case 'STREAM':
      if (input.service_id === 'slack') {
        const { App } = await import('@slack/bolt');
        const botToken = token || secretGuard.getSecret('SLACK_BOT_TOKEN', 'slack');
        const appToken = secretGuard.getSecret('SLACK_APP_TOKEN', 'slack');
        
        if (!botToken || !appToken) throw new Error('Slack tokens missing for streaming.');

        const app = new App({ token: botToken, appToken, socketMode: true, logLevel: 'error' as any });
        
        app.event('app_mention', async ({ event }) => {
          if (onEvent) onEvent({ type: 'mention', event });
        });
        
        app.message(async ({ event }) => {
          const e = event as any;
          if (e.channel_type === 'im' || e.channel?.startsWith('D')) {
            if (onEvent) onEvent({ type: 'dm', event: e });
          }
        });

        await app.start();
        return { status: 'streaming_active' };
      }
      throw new Error(`Streaming not implemented for ${input.service_id}`);

    case 'API':
      let baseUrl: string;
      if (input.service_id === 'moltbook') {
        baseUrl = 'https://www.moltbook.com/api/v1';
      } else if (input.service_id === 'slack') {
        baseUrl = 'https://slack.com/api';
      } else {
        baseUrl = `https://api.${input.service_id}.com/v1`;
      }

      const httpMethod = input.method || (input.params ? 'POST' : 'GET');
      return await secureFetch({
        method: httpMethod,
        url: `${baseUrl}/${input.action}`,
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        data: httpMethod !== 'GET' ? input.params : undefined,
        params: httpMethod === 'GET' ? input.params : undefined
      });

    case 'CLI':
      const cliBin = `${input.service_id}`; 
      const args = [input.action, ...Object.values(input.params)];
      logger.info(`⌨️  [CLI] Executing: ${cliBin} ${args.join(' ')}`);
      return { output: safeExec(cliBin, args as string[]) };

    default:
      throw new Error(`Unsupported mode: ${input.mode}`);
  }
}

// ... CLI code (unchanged)
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv.input as string), 'utf8')) as ServiceAction;
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

// CLI Integration
const isMain = process.argv[1] && (
  process.argv[1].endsWith('service-actuator/src/index.ts') || 
  process.argv[1].endsWith('service-actuator/dist/index.js')
);

if (isMain) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };

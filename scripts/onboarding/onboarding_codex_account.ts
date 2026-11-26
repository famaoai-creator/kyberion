import { safeChildEnv } from '@agent/core/foundation/env';
import { resolveCodexBinary } from '@agent/core/provider/codex-cli-query';
import { resolveCodexHome } from '@agent/core/provider/codex-profile';
import { safeSpawn } from '@agent/core/secure-io';

type CodexAccountInfo = {
  status: 'available' | 'unavailable';
  provider: 'codex';
  account_type: string | null;
  plan: string | null;
  training_use: 'unknown';
};

function accountField(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/iu.test(value) ? value : null;
}

/** Query the installed local CLI. Never return the email or raw response. */
export async function inspectCodexAccount(): Promise<CodexAccountInfo> {
  const unavailable = {
    status: 'unavailable',
    provider: 'codex',
    account_type: null,
    plan: null,
    training_use: 'unknown',
  } as const;
  try {
    return await new Promise<CodexAccountInfo>((resolve) => {
      const child = safeSpawn(resolveCodexBinary(), ['app-server', '--listen', 'stdio://'], {
        env: safeChildEnv({ ...process.env, CODEX_HOME: resolveCodexHome(undefined, process.env) }),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let buffer = '';
      let initialized = false;
      let done = false;
      const finish = (result = unavailable as CodexAccountInfo) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        if (!child.killed) child.kill('SIGKILL');
        resolve(result);
      };
      const deadline = setTimeout(() => finish(), 5000);
      const send = (payload: Record<string, unknown>) =>
        child.stdin?.write(JSON.stringify(payload) + '\n');
      child.on('error', () => finish());
      child.on('exit', () => finish());
      child.stdin?.on('error', () => finish());
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 64 * 1024) {
          finish();
          return;
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (message?.id === 1 && message.result && !initialized) {
              initialized = true;
              send({ method: 'initialized' });
              send({ id: 2, method: 'account/read', params: { refreshToken: false } });
            }
            if (message?.id === 2 && initialized) {
              const account = message.result?.account;
              finish(
                message.result
                  ? {
                      ...unavailable,
                      status: 'available',
                      account_type: accountField(account?.type),
                      plan: accountField(account?.planType),
                    }
                  : unavailable
              );
            }
          } catch {
            // Ignore non-JSON notifications and startup output.
          }
        }
      });
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'kyberion-account-check', version: '1.0.0' } },
      });
    });
  } catch {
    return unavailable;
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HerdrRuntimeClient, type HerdrExecFn } from './agent-pane-runtime-herdr.js';

const KEY = 'sk-ant-herdr-real-key-0123456789';

function clientCapturingEnv(): {
  client: HerdrRuntimeClient;
  envs: (Record<string, string> | undefined)[];
} {
  const envs: (Record<string, string> | undefined)[] = [];
  const exec: HerdrExecFn = (_command, _args, options) => {
    envs.push(options?.env);
    return { stdout: '{"result":{}}', stderr: '', status: 0 };
  };
  return { client: new HerdrRuntimeClient({ bin: 'herdr', exec }), envs };
}

afterEach(() => vi.unstubAllEnvs());

describe('herdr pane runtime env with the credential relay flag', () => {
  it('passes the inherited key through when the flag is off', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    const { client, envs } = clientCapturingEnv();
    client.run(['agent', 'list']);
    client.readAgent('pane-1');
    expect(envs.map((env) => env?.ANTHROPIC_API_KEY)).toEqual([KEY, KEY]);
  });

  it('drops the key for run (agent start) and readAgent when the flag is on', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-herdr-real-key-0123456789');
    vi.stubEnv('KYBERION_PROVIDER_CREDENTIAL_RELAY', '1');
    const { client, envs } = clientCapturingEnv();
    client.run(['agent', 'start', '--kind', 'claude']);
    client.readAgent('pane-1');
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.OPENAI_API_KEY).toBeUndefined();
    }
  });
});

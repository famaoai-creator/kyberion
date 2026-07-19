import { describe, expect, it } from 'vitest';

import { ActuatorServeClient } from './actuator-serve-client.js';
import { ACTUATOR_SERVE_RESULT_PREFIX } from './cli-utils.js';

/**
 * Fake serve-mode actuator: echoes each request back framed with the
 * serve prefix, mixed with log noise on stdout to prove the client
 * filters frames correctly.
 */
function fakeServeCommand(): string[] {
  return [
    process.execPath,
    '-e',
    [
      `const P=${JSON.stringify(ACTUATOR_SERVE_RESULT_PREFIX)};`,
      'process.stdin.setEncoding("utf8");let b="";',
      'console.log("[fake-actuator] booted");',
      'process.stdin.on("data",d=>{b+=d;let i;',
      'while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);',
      'if(!l)continue;const m=JSON.parse(l);',
      'console.log("[fake-actuator] handling request");',
      'if(m.input && m.input.explode){console.log(P+JSON.stringify({id:m.id,ok:false,error:"boom"}));continue}',
      'console.log(P+JSON.stringify({id:m.id,ok:true,result:{echo:m.input}}));}});',
    ].join(''),
  ];
}

describe('actuator serve client', () => {
  it('round-trips requests through a warm process, ignoring log lines', async () => {
    const client = new ActuatorServeClient({ command: fakeServeCommand(), label: 'fake' });
    try {
      const first = await client.request({ action: 'generate_voice', text: 'こんにちは' });
      expect(first).toEqual({ echo: { action: 'generate_voice', text: 'こんにちは' } });
      const second = await client.request({ action: 'generate_voice', text: '二回目' });
      expect(second).toEqual({ echo: { action: 'generate_voice', text: '二回目' } });
    } finally {
      await client.dispose();
    }
  });

  it('rejects when the actuator reports an error', async () => {
    const client = new ActuatorServeClient({ command: fakeServeCommand(), label: 'fake' });
    try {
      await expect(client.request({ explode: true })).rejects.toThrow(/boom/);
    } finally {
      await client.dispose();
    }
  });

  it('rejects pending requests when the process exits and recovers on the next call', async () => {
    const client = new ActuatorServeClient({
      command: [process.execPath, '-e', 'setTimeout(()=>process.exit(2),100)'],
      label: 'dying',
      requestTimeoutMs: 5000,
    });
    try {
      await expect(client.request({ action: 'x' })).rejects.toThrow(/exited code=2/);
    } finally {
      await client.dispose();
    }
  });

  it('aborts a pending request and terminates the warm process', async () => {
    const client = new ActuatorServeClient({
      command: [process.execPath, '-e', 'process.stdin.resume()'],
      label: 'hanging',
      requestTimeoutMs: 5000,
    });
    const controller = new AbortController();
    try {
      const pending = client.request({ action: 'slow' }, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/);
    } finally {
      await client.dispose();
    }
  });

  it('refuses requests after dispose', async () => {
    const client = new ActuatorServeClient({ command: fakeServeCommand(), label: 'fake' });
    await client.dispose();
    await expect(client.request({})).rejects.toThrow(/disposed/);
  });
});

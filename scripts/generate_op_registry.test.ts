import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('generate_op_registry discovery output', () => {
  it('includes input schemas and examples for contract-backed ops', () => {
    const discovery = JSON.parse(
      String(
        safeReadFile(pathResolver.knowledge('product/orchestration/actuator-op-discovery.json'), {
          encoding: 'utf8',
        }) || '{}'
      )
    );
    const browser = discovery.actuators.find((entry: any) => entry.n === 'browser-actuator');
    const system = discovery.actuators.find((entry: any) => entry.n === 'system-actuator');
    const file = discovery.actuators.find((entry: any) => entry.n === 'file-actuator');

    expect(browser?.ops.find((item: any) => item.op === 'goto')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['url'],
      }),
      examples: expect.arrayContaining([expect.objectContaining({ url: 'https://example.com' })]),
    });
    expect(system?.ops.find((item: any) => item.op === 'open_url')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['url'],
      }),
    });
    expect(system?.ops.find((item: any) => item.op === 'app_quit')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['application'],
      }),
    });
    expect(system?.ops.find((item: any) => item.op === 'process_kill')).toMatchObject({
      input_schema: expect.objectContaining({
        anyOf: expect.arrayContaining([
          expect.objectContaining({ required: ['pid'] }),
          expect.objectContaining({ required: ['name'] }),
        ]),
      }),
    });
    expect(file?.ops.find((item: any) => item.op === 'read_json')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['path'],
      }),
      examples: expect.arrayContaining([
        expect.objectContaining({ path: 'knowledge/product/config.json' }),
      ]),
    });
  });
});

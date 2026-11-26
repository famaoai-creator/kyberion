import { describe, expect, it } from 'vitest';
import { pinPipelineSessionContext } from './pipeline-execution-part-session.js';

describe('pinPipelineSessionContext', () => {
  it('takes the browser session and options from the pipeline file, never the caller', () => {
    const context: Record<string, unknown> = {
      topic: 'kept',
      __pipeline_options: { navigation_policy: { allow_private_network: true } },
      __pipeline_session_id: 'caller-chosen',
    };
    pinPipelineSessionContext(context, { session_id: 'flow', options: { headless: false } });
    expect(context).toEqual({
      topic: 'kept',
      __pipeline_options: { headless: false },
      __pipeline_session_id: 'flow',
    });
  });

  it('drops a caller session when the pipeline declares none', () => {
    const context: Record<string, unknown> = { __pipeline_session_id: 'caller-chosen' };
    pinPipelineSessionContext(context, {});
    expect(context).toEqual({ __pipeline_options: {} });
  });
});

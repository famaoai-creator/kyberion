import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as pathResolver from '@agent/core/path-resolver';
import {
  normalizeTimelineDispatchResponse,
  resolvePresenceDispatchRoute,
} from './presence-actuator-helpers.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('presence-actuator schema', () => {
  it('accepts supported presence actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'knowledge/product/schemas/presence-action.schema.json')
    );

    expect(
      validate({
        action: 'dispatch',
        params: {
          channel: 'general',
          payload: {
            text: 'hello world',
          },
        },
      }),
      JSON.stringify(validate.errors || [])
    ).toBe(true);

    expect(
      validate({
        action: 'receive_event',
        params: {
          channel: 'general',
          payload: {
            event_type: 'click',
          },
        },
      }),
      JSON.stringify(validate.errors || [])
    ).toBe(true);
  });

  it('rejects unsupported presence actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'knowledge/product/schemas/presence-action.schema.json')
    );

    expect(
      validate({
        action: 'unsupported',
        params: {},
      })
    ).toBe(false);
  });

  it('routes prefixed channels to satellite outbox and keeps Slack default', () => {
    expect(resolvePresenceDispatchRoute('general')).toEqual({
      surface: 'slack',
      channel: 'general',
      via: 'slack',
    });
    expect(resolvePresenceDispatchRoute('slack:C123')).toEqual({
      surface: 'slack',
      channel: 'C123',
      via: 'slack',
    });
    expect(resolvePresenceDispatchRoute('telegram:12345')).toEqual({
      surface: 'telegram',
      channel: '12345',
      via: 'satellite-outbox',
    });
    expect(resolvePresenceDispatchRoute('discord:99')).toEqual({
      surface: 'discord',
      channel: '99',
      via: 'satellite-outbox',
    });
    expect(resolvePresenceDispatchRoute('imessage:chat-1')).toEqual({
      surface: 'imessage',
      channel: 'chat-1',
      via: 'satellite-outbox',
    });
    expect(() => resolvePresenceDispatchRoute('telegram:')).toThrow('channel id is empty');
  });

  it('rejects non-object timeline bridge responses before result projection', () => {
    expect(normalizeTimelineDispatchResponse({ accepted: true })).toEqual({ accepted: true });
    expect(() => normalizeTimelineDispatchResponse([])).toThrow(
      'timeline dispatch response must be a JSON object'
    );
    expect(() => normalizeTimelineDispatchResponse('accepted')).toThrow(
      'timeline dispatch response must be a JSON object'
    );
  });
});

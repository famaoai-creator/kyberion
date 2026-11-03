import { describe, expect, it } from 'vitest';
import {
  parseSurfaceControlActionResponse,
  parseSurfaceControlResponse,
} from './surface-control-response';

const action = { operation: 'status', label: 'Status', risk: 'safe', enabled: true };
const valid = {
  surfaces: [{ id: 'chronos', kind: 'next', running: true, health: 'healthy', detail: 'ready' }],
  controlActions: [
    { kind: 'surface', target: 'chronos', operation: 'status', status: 'completed' },
  ],
  controlActionAvailability: { globalSurface: [action], surface: { chronos: [action] } },
};

describe('surface control response boundary', () => {
  it('accepts the GET and queued POST projections', () => {
    expect(parseSurfaceControlResponse(valid)).toEqual(valid);
    expect(
      parseSurfaceControlActionResponse({
        status: 'queued',
        action: 'surface_control',
        surfaceId: '',
        operation: 'reconcile',
        eventId: 'evt-1',
        ts: '2026-09-04T00:00:00.000Z',
      })
    ).toMatchObject({ status: 'queued', operation: 'reconcile' });
  });

  it.each([
    ['invalid surface', { ...valid, surfaces: [{ ...valid.surfaces[0], running: 'yes' }] }],
    [
      'invalid action risk',
      {
        ...valid,
        controlActionAvailability: {
          ...valid.controlActionAvailability,
          globalSurface: [{ ...action, risk: 'danger' }],
        },
      },
    ],
    [
      'invalid action summary',
      { ...valid, controlActions: [{ ...valid.controlActions[0], status: 'unknown' }] },
    ],
    [
      'invalid availability',
      { ...valid, controlActionAvailability: { globalSurface: [], surface: [] } },
    ],
    [
      'dangerous nested key',
      {
        ...valid,
        controlActionAvailability: { ...valid.controlActionAvailability, ['__proto__']: {} },
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseSurfaceControlResponse(value)).toBeUndefined();
  });

  it.each([
    [
      'wrong status',
      {
        status: 'completed',
        action: 'surface_control',
        surfaceId: '',
        operation: 'status',
        eventId: 'e',
        ts: 't',
      },
    ],
    [
      'wrong action',
      {
        status: 'queued',
        action: 'other',
        surfaceId: '',
        operation: 'status',
        eventId: 'e',
        ts: 't',
      },
    ],
    [
      'wrong operation',
      {
        status: 'queued',
        action: 'surface_control',
        surfaceId: '',
        operation: 'restart',
        eventId: 'e',
        ts: 't',
      },
    ],
    [
      'missing event',
      {
        status: 'queued',
        action: 'surface_control',
        surfaceId: '',
        operation: 'status',
        eventId: '',
        ts: 't',
      },
    ],
  ])('rejects queued response %s', (_label, value) => {
    expect(parseSurfaceControlActionResponse(value)).toBeUndefined();
  });
});

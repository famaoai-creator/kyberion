import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import {
  collectControlActionDetails,
  collectControlActions,
  collectOwnerSummaries,
  collectRecentEvents,
} from './intelligence-observations';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

const root = pathResolver.sharedTmp(`intelligence-observation-events-${process.pid}`);

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('intelligence observation event resource boundary', () => {
  it('does not project event data from a symlinked observability file', () => {
    const external = path.join(root, 'external.jsonl');
    const linked = path.join(root, 'linked.jsonl');
    safeMkdir(root, { recursive: true });
    safeWriteFile(
      external,
      [
        JSON.stringify({ decision: 'external-event', ts: '2099-01-01T00:00:00.000Z' }),
        JSON.stringify({
          decision: 'mission_control_action_applied',
          event_id: 'external-action',
          operation: 'external',
          ts: '2099-01-01T00:00:00.000Z',
        }),
        JSON.stringify({
          event_type: 'mission_owner_notified',
          mission_id: 'external-mission',
          ts: '2099-01-01T00:00:00.000Z',
        }),
      ].join('\n') + '\n'
    );
    safeSymlinkSync(external, linked);

    expect(collectRecentEvents({ observationFiles: [linked] })).toEqual([]);
    expect(collectControlActions({ observationFiles: [linked] })).toEqual([]);
    expect(collectControlActionDetails({ observationFiles: [linked] })).toEqual({});
    expect(collectOwnerSummaries({ observationFiles: [linked] })).toEqual([]);
  });

  it('skips malformed and non-object JSONL rows while projecting valid events', () => {
    const file = path.join(root, 'events.jsonl');
    safeMkdir(root, { recursive: true });
    safeWriteFile(
      file,
      [
        '{',
        '[]',
        JSON.stringify({
          decision: 'mission_orchestration_event_enqueued',
          event_type: 'mission_control_requested',
          event_id: 'valid-action',
          mission_id: 'mission-1',
          requested_by: 'operator',
          ts: '2099-01-01T00:00:00.000Z',
          payload: { operation: 'pause' },
        }),
      ].join('\n') + '\n'
    );

    expect(collectRecentEvents({ observationFiles: [file] })).toEqual([
      expect.objectContaining({ decision: 'mission_orchestration_event_enqueued' }),
    ]);
    expect(collectControlActions({ observationFiles: [file] })).toEqual([
      expect.objectContaining({ event_id: 'valid-action', status: 'queued' }),
    ]);
  });
});

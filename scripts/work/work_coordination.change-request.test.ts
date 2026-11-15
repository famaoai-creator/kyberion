import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
} from '@agent/core/workforce/work-coordination';
import { main } from './work_coordination.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-coordination-change-request-cli-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

async function run<T = Record<string, unknown>>(args: string[]): Promise<T> {
  const printed: unknown[] = [];
  await main(args, (value) => printed.push(value));
  return JSON.parse(String(printed.at(-1))) as T;
}

describe('pnpm work change-request commands', () => {
  it('claims, links, resolves the owner and records a merge through the CLI', async () => {
    await run(['create-item', '--item-id', 'WI-CLI', '--title', 'cli', '--description', 'x']);
    const { lease } = await run<{ lease: { lease_id: string } }>([
      'claim-item',
      '--item-id',
      'WI-CLI',
      '--actor-peer-id',
      'peer:codex',
    ]);
    await run([
      'link-change',
      '--item-id',
      'WI-CLI',
      '--actor-peer-id',
      'peer:codex',
      '--branch',
      'feat/cli',
      '--forge',
      'local',
    ]);

    const owner = await run<{ item: { item_id: string }; owner: unknown }>([
      'change-owner',
      '--branch',
      'feat/cli',
    ]);
    expect(owner.item.item_id).toBe('WI-CLI');
    expect(owner.owner).toMatchObject({ peer_id: 'peer:codex', lease_id: lease.lease_id });

    await run([
      'release-item',
      '--item-id',
      'WI-CLI',
      '--lease-id',
      lease.lease_id,
      '--actor-peer-id',
      'peer:codex',
    ]);
    await run([
      'update-change',
      '--item-id',
      'WI-CLI',
      '--actor-peer-id',
      'peer:observer',
      '--change-state',
      'merged',
    ]);
    const { changes } = await run<{ changes: Array<{ change_request: { branch: string } }> }>([
      'list-changes',
      '--change-state',
      'merged',
    ]);
    expect(changes.map((entry) => entry.change_request.branch)).toEqual(['feat/cli']);
  });
});

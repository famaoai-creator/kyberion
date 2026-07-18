import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withExecutionContext } from './authority.js';
import {
  deadLetterSurfaceOutboxMessage,
  clearSurfaceDeadTarget,
  enqueueSurfaceOutboxMessage,
  getSurfaceDeadTarget,
  listSurfaceDeadLetters,
  listSurfaceOutboxMessages,
  listSurfaceDeadTargets,
  markSurfaceDeadTarget,
  replaySurfaceDeadLetter,
} from './surface-coordination-store.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

const testSurface = 'imessage';
const testPrefix = `SURFACE-QUARANTINE-${process.pid}-${Date.now()}`;
const outboxDir = pathResolver.resolve(`active/shared/coordination/channels/${testSurface}/outbox`);
const quarantineDir = pathResolver.resolve(
  `active/shared/coordination/channels/${testSurface}/outbox/.quarantine`
);
const deadLetterDir = pathResolver.resolve(
  `active/shared/coordination/channels/${testSurface}/dead-letter`
);
const deadLetterQuarantineDir = pathResolver.resolve(
  `active/shared/coordination/channels/${testSurface}/dead-letter/.quarantine`
);
const deadTargetDir = pathResolver.resolve(
  `active/shared/coordination/channels/${testSurface}/dead-targets`
);
const deadTargetQuarantineDir = pathResolver.resolve(
  `active/shared/coordination/channels/${testSurface}/dead-targets/.quarantine`
);
const testDeadTargetChannel = `${testPrefix}-dead-target`;
const malformedDeadTargetChannel = `${testPrefix}-dead-target-malformed`;
const malformedDeadTargetPath = path.join(
  deadTargetDir,
  `${createHash('sha256').update(malformedDeadTargetChannel).digest('hex').slice(0, 32)}.json`
);
const createdOutboxFiles: string[] = [];

afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    clearSurfaceDeadTarget(testSurface, 'channel-replay');
    clearSurfaceDeadTarget(testSurface, testDeadTargetChannel);
    for (const filePath of createdOutboxFiles.splice(0)) safeUnlinkSync(filePath);
    for (const directory of [
      outboxDir,
      quarantineDir,
      deadLetterDir,
      deadLetterQuarantineDir,
      deadTargetDir,
      deadTargetQuarantineDir,
    ]) {
      if (!safeExistsSync(directory)) continue;
      for (const name of safeReaddir(directory)) {
        const filePath = path.join(directory, name);
        if (name.includes(testPrefix)) {
          safeUnlinkSync(filePath);
          continue;
        }
        if (directory === deadLetterDir) {
          try {
            const raw = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
              correlation_id?: string;
            };
            if (raw.correlation_id?.includes(testPrefix)) safeUnlinkSync(filePath);
          } catch {
            // Ignore unrelated or already-cleaned fixture files.
          }
        }
        if (directory === deadTargetDir) {
          try {
            const raw = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
              channel?: string;
            };
            if (raw.channel?.includes(testPrefix)) safeUnlinkSync(filePath);
          } catch {
            // Ignore unrelated or already-cleaned fixture files.
          }
        }
        if (
          directory === deadTargetQuarantineDir &&
          name.startsWith(`${path.basename(malformedDeadTargetPath)}.`)
        ) {
          safeUnlinkSync(filePath);
        }
      }
    }
  });
});

describe('surface coordination outbox recovery', () => {
  it('quarantines malformed records and keeps valid messages readable', () => {
    const malformedPath = path.join(outboxDir, `${testPrefix}-MALFORMED.json`);
    withExecutionContext('surface_runtime', () => {
      safeMkdir(outboxDir, { recursive: true });
      safeWriteFile(malformedPath, '{not-json');
    });

    const messagePath = enqueueSurfaceOutboxMessage({
      surface: testSurface,
      correlationId: `${testPrefix}-valid`,
      channel: 'channel-1',
      threadTs: '',
      text: 'valid message',
    });
    createdOutboxFiles.push(messagePath);

    const messages = listSurfaceOutboxMessages(testSurface).filter(
      (message) => message.correlation_id === `${testPrefix}-valid`
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message_id: path.basename(messagePath, '.json'),
      text: 'valid message',
    });
    expect(safeExistsSync(malformedPath)).toBe(false);

    const quarantinedFiles = safeReaddir(quarantineDir).filter((name) => name.includes(testPrefix));
    expect(quarantinedFiles).toHaveLength(1);
    expect(safeReadFile(path.join(quarantineDir, quarantinedFiles[0]), { encoding: 'utf8' })).toBe(
      '{not-json'
    );
  });

  it('quarantines schema-invalid JSON records', () => {
    const invalidPath = path.join(outboxDir, `${testPrefix}-INVALID.json`);
    withExecutionContext('surface_runtime', () => {
      safeMkdir(outboxDir, { recursive: true });
      safeWriteFile(invalidPath, JSON.stringify({ message_id: `${testPrefix}-invalid` }));
    });

    expect(
      listSurfaceOutboxMessages(testSurface).some(
        (message) => message.message_id === `${testPrefix}-invalid`
      )
    ).toBe(false);
    expect(safeExistsSync(invalidPath)).toBe(false);
    expect(safeReaddir(quarantineDir).filter((name) => name.includes(testPrefix))).toHaveLength(1);
  });

  it('reuses an existing outbox record for the same producer deduplication key', () => {
    const deduplicationKey = `${testPrefix}-dedup`;
    const firstPath = enqueueSurfaceOutboxMessage({
      surface: testSurface,
      correlationId: `${testPrefix}-dedup-correlation`,
      channel: 'channel-dedup',
      threadTs: '',
      text: 'first delivery',
      deduplicationKey,
    });
    createdOutboxFiles.push(firstPath);

    const secondPath = enqueueSurfaceOutboxMessage({
      surface: testSurface,
      correlationId: `${testPrefix}-dedup-correlation-retry`,
      channel: 'channel-dedup',
      threadTs: '',
      text: 'retry must not duplicate',
      deduplicationKey,
    });

    expect(secondPath).toBe(firstPath);
    expect(
      listSurfaceOutboxMessages(testSurface).filter(
        (message) => message.deduplication_key === deduplicationKey
      )
    ).toHaveLength(1);
  });

  it('quarantines malformed dead-letter records and keeps valid records readable', () => {
    const malformedPath = path.join(deadLetterDir, `${testPrefix}-DEAD-MALFORMED.json`);
    const invalidPath = path.join(deadLetterDir, `${testPrefix}-DEAD-INVALID.json`);
    withExecutionContext('surface_runtime', () => {
      safeMkdir(deadLetterDir, { recursive: true });
      safeWriteFile(malformedPath, '{not-json');
      safeWriteFile(invalidPath, JSON.stringify({ kind: 'surface-dead-letter' }));
    });

    const messagePath = enqueueSurfaceOutboxMessage({
      surface: testSurface,
      correlationId: `${testPrefix}-dead-valid-correlation`,
      channel: 'channel-dead-valid',
      threadTs: '',
      text: 'valid dead-letter',
    });
    const deadLetter = withExecutionContext('surface_runtime', () =>
      deadLetterSurfaceOutboxMessage(testSurface, path.basename(messagePath, '.json'), {
        kind: 'transient',
        retryable: true,
        reason: 'provider unavailable',
      })
    );
    expect(deadLetter).not.toBeNull();

    expect(listSurfaceDeadLetters(testSurface)).toContainEqual(
      expect.objectContaining({
        dead_letter_id: deadLetter!.dead_letter_id,
        correlation_id: `${testPrefix}-dead-valid-correlation`,
      })
    );
    expect(safeExistsSync(malformedPath)).toBe(false);
    expect(safeExistsSync(invalidPath)).toBe(false);
    expect(
      safeReaddir(deadLetterQuarantineDir).filter((name) => name.includes(testPrefix))
    ).toHaveLength(2);
  });

  it('quarantines malformed dead-target records without breaking valid registry entries', () => {
    const invalidPath = path.join(deadTargetDir, `${testPrefix}-DEAD-TARGET-INVALID.json`);
    withExecutionContext('surface_runtime', () => {
      safeMkdir(deadTargetDir, { recursive: true });
      safeWriteFile(malformedDeadTargetPath, '{not-json');
      safeWriteFile(
        invalidPath,
        JSON.stringify({ surface: testSurface, channel: 'missing-fields' })
      );
    });

    markSurfaceDeadTarget(testSurface, testDeadTargetChannel, {
      kind: 'forbidden',
      retryable: false,
      reason: 'target removed',
    });

    expect(getSurfaceDeadTarget(testSurface, malformedDeadTargetChannel)).toBeNull();
    expect(listSurfaceDeadTargets(testSurface)).toContainEqual(
      expect.objectContaining({ channel: testDeadTargetChannel, consecutive_failures: 1 })
    );
    expect(safeExistsSync(malformedDeadTargetPath)).toBe(false);
    expect(safeExistsSync(invalidPath)).toBe(false);
    const quarantinedFiles = safeReaddir(deadTargetQuarantineDir);
    expect(quarantinedFiles.some((name) => name.includes(testPrefix))).toBe(true);
    expect(
      quarantinedFiles.some((name) => name.startsWith(`${path.basename(malformedDeadTargetPath)}.`))
    ).toBe(true);
  });

  it('replays a dead-letter only after the operator supplies identity and a repaired target', () => {
    const messagePath = enqueueSurfaceOutboxMessage({
      surface: testSurface,
      correlationId: `${testPrefix}-replay-correlation`,
      channel: 'channel-replay',
      threadTs: '',
      text: 'replay me',
      deduplicationKey: `${testPrefix}-replay-key`,
    });
    const deadLetter = withExecutionContext('surface_runtime', () =>
      deadLetterSurfaceOutboxMessage(testSurface, path.basename(messagePath, '.json'), {
        kind: 'transient',
        retryable: true,
        reason: 'temporary provider outage',
      })
    );
    expect(deadLetter).not.toBeNull();
    expect(listSurfaceOutboxMessages(testSurface)).not.toContainEqual(
      expect.objectContaining({ correlation_id: `${testPrefix}-replay-correlation` })
    );

    expect(() =>
      replaySurfaceDeadLetter(testSurface, deadLetter!.dead_letter_id, { operatorId: '' })
    ).toThrow('[POLICY_VIOLATION] Surface dead-letter replay requires');

    markSurfaceDeadTarget(testSurface, 'channel-replay', {
      kind: 'forbidden',
      retryable: false,
      reason: 'target still needs repair',
    });
    expect(() =>
      replaySurfaceDeadLetter(testSurface, deadLetter!.dead_letter_id, {
        operatorId: 'operator-test',
      })
    ).toThrow('[POLICY_VIOLATION] Surface target remains marked dead');
    withExecutionContext('surface_runtime', () =>
      clearSurfaceDeadTarget(testSurface, 'channel-replay')
    );

    const replayPath = replaySurfaceDeadLetter(testSurface, deadLetter!.dead_letter_id, {
      operatorId: 'operator-test',
    });
    createdOutboxFiles.push(replayPath);
    expect(listSurfaceOutboxMessages(testSurface)).toContainEqual(
      expect.objectContaining({
        correlation_id: `${testPrefix}-replay-correlation`,
        text: 'replay me',
      })
    );
    const replayAgainPath = replaySurfaceDeadLetter(testSurface, deadLetter!.dead_letter_id, {
      operatorId: 'operator-test-2',
    });
    expect(replayAgainPath).toBe(replayPath);
    expect(
      listSurfaceOutboxMessages(testSurface).filter(
        (message) => message.deduplication_key === `${testPrefix}-replay-key`
      )
    ).toHaveLength(1);
    const updated = listSurfaceDeadLetters(testSurface).find(
      (record) => record.dead_letter_id === deadLetter!.dead_letter_id
    );
    expect(updated).toMatchObject({
      replay_count: 2,
      last_replayed_by: 'operator-test-2',
      last_replay_message_id: path.basename(replayPath, '.json'),
    });
  });
});

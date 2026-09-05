import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMeetingAttendeesAtPath } from '@agent/core/meeting-attendees';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { parseMeetingAttendeesJson, resolveMeetingResourcePath } from './meeting_orchestrator.js';

const fixtureDir = pathResolver.active(`shared/tmp/meeting-orchestrator-boundary-${process.pid}`);

afterEach(() => safeRmSync(fixtureDir, { recursive: true, force: true }));

describe('meeting orchestrator resource boundaries', () => {
  it('rejects profile and attendee paths outside the repository', () => {
    expect(() => resolveMeetingResourcePath('../outside.json')).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() => resolveMeetingResourcePath('/tmp/outside.json')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects missing resource paths instead of passing them to the JSON reader', () => {
    expect(() => resolveMeetingResourcePath('knowledge/product/missing-profile.json')).toThrow(
      /does not exist/
    );
  });

  it('rejects a directory before passing it to the JSON reader', () => {
    safeMkdir(fixtureDir, { recursive: true });
    const directoryPath = path.join(fixtureDir, 'profile.json');
    safeMkdir(directoryPath, { recursive: true });

    expect(() => resolveMeetingResourcePath(pathResolver.toRepoRelative(directoryPath))).toThrow(
      '[MEETING_RESOURCE_FILE]'
    );
  });

  it('rejects dangerous attendee JSON before orchestration', () => {
    expect(parseMeetingAttendeesJson('[{"name":"A"}]')).toEqual([{ name: 'A' }]);
    expect(() => parseMeetingAttendeesJson('{"__proto__":{"name":"unsafe"}}')).toThrow(
      '--attendees contains a dangerous JSON key'
    );
    expect(() => parseMeetingAttendeesJson('[{"name":""}]')).toThrow(
      /Invalid catalog meeting-attendees/u
    );
    expect(() => parseMeetingAttendeesJson('[{"name":"A","unexpected":true}]')).toThrow(
      /Invalid catalog meeting-attendees/u
    );
  });

  it('validates attendee files through the canonical loader', () => {
    safeMkdir(fixtureDir, { recursive: true });
    const attendeesPath = path.join(fixtureDir, 'attendees.json');
    safeWriteFile(attendeesPath, JSON.stringify([{ name: 'A', person_slug: 'a' }]));
    expect(loadMeetingAttendeesAtPath(attendeesPath)).toEqual([{ name: 'A', person_slug: 'a' }]);
    safeWriteFile(attendeesPath, JSON.stringify([{ name: 'A', unexpected: true }]));
    expect(() => loadMeetingAttendeesAtPath(attendeesPath)).toThrow(
      /Invalid catalog meeting-attendees/u
    );
  });

  it('routes both attendee input forms through the canonical contract', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/meeting_orchestrator.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('validateMeetingAttendees(');
    expect(source).toContain('loadMeetingAttendeesAtPath(');
    expect(source).not.toContain('readJson(');
  });
});

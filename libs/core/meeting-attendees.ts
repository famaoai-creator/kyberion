import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export interface MeetingAttendee {
  name: string;
  person_slug?: string;
  channel_handle?: string;
  role_hint?: 'planner' | 'facilitator' | 'scribe' | 'executor' | 'decision_maker' | 'tracker';
}

const MEETING_ATTENDEES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/meeting-attendees.schema.json'
);

function meetingAttendeesCatalog(sourcePath: string) {
  return defineCatalog<MeetingAttendee[]>({
    id: 'meeting-attendees',
    path: sourcePath,
    schema: MEETING_ATTENDEES_SCHEMA_PATH,
  });
}

/** Validate inline or already-parsed attendees through the shared contract. */
export function validateMeetingAttendees(
  value: unknown,
  sourcePath = '--attendees'
): MeetingAttendee[] {
  return meetingAttendeesCatalog(sourcePath).validate(value, sourcePath);
}

/** Load attendees from a repository-scoped regular file through the shared contract. */
export function loadMeetingAttendeesAtPath(filePath: string): MeetingAttendee[] {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`[MEETING_ATTENDEES_FILE] attendees must be a regular file: ${filePath}`);
  }
  return meetingAttendeesCatalog(safePath).load();
}

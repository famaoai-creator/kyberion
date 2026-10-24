import * as path from 'node:path';
import {
  CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
  customerDecisionConsumerWriteProblem,
} from './customer-decision-consumer-capability.js';
import {
  CUSTOMER_DECISION_MILESTONE_STORE_ROLE,
  customerDecisionMilestoneWriteProblem,
} from './customer-decision-milestone-capability.js';

/** Content of a file write, when the caller writes whole bytes (secure-io `safeWriteFile`). */
export type WriteContent = string | Buffer;

/**
 * Roles whose store rules are content rules (CD-09 / CD-10): the tier guard
 * checks each of their writes against the file on disk, so a process that
 * builds the capability itself and calls secure-io directly is held to the
 * same rules as the store. A write without content (append, copy, rename,
 * link, unlink) is refused for them.
 */
export const CONTENT_CHECKED_ROLES: ReadonlySet<string> = new Set([
  CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
  CUSTOMER_DECISION_MILESTONE_STORE_ROLE,
]);

/** An unparseable record: never undefined (that would read as "absent"). */
function parseJsonOrInvalid(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The refusal reason of a content-checked role's write, or null when allowed.
 * `caseDir` is the case directory of the role's capability (repo-relative);
 * `readRepoFile` reads a repo-relative file raw (undefined when absent) — the
 * guard's own read, outside any caller scope.
 */
export function customerDecisionWriteContentDenial(
  role: string,
  relativePath: string,
  content: WriteContent | undefined,
  caseDir: string | undefined,
  readRepoFile: (repoRelative: string) => string | undefined
): string | null {
  const prefix = caseDir ? `${caseDir}/` : '';
  if (content === undefined || !caseDir || !relativePath.startsWith(prefix))
    return `[CUSTOMER_DECISION_WRITE_CONTENT_REQUIRED] role '${role}' writes only whole records whose content the guard checks`;
  const readCaseFile = (relative: string) => readRepoFile(path.posix.join(caseDir, relative));
  const relative = relativePath.slice(prefix.length);
  let previous: unknown;
  try {
    const onDisk = readCaseFile(relative);
    previous = onDisk === undefined ? undefined : parseJsonOrInvalid(onDisk);
  } catch {
    return '[CUSTOMER_DECISION_WRITE_CONTENT_REQUIRED] the record on disk could not be read for the content check';
  }
  const next = parseJsonOrInvalid(typeof content === 'string' ? content : content.toString('utf8'));
  return role === CUSTOMER_DECISION_CONSUMER_STORE_ROLE
    ? customerDecisionConsumerWriteProblem(relative, previous, next, readCaseFile)
    : customerDecisionMilestoneWriteProblem(previous, next);
}

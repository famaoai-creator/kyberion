/** Browser-safe bounded diagnostic protocol. Request fields convey no authority. */
import {
  parseFrontDeskArtifactRevisionInput,
  type FrontDeskArtifactRevisionInput,
} from './front-desk-artifact-revision-contract.js';

export type FirstJobRequest = {
  request_id: string;
  session_id?: string;
  /** Raw locale carrier; supported-locale normalization belongs to the domain boundary. */
  locale?: string;
} & ({ action: 'start' } | { action: 'revise'; artifactRevision: FrontDeskArtifactRevisionInput });
export interface FirstJobReadRequest {
  session_id?: string;
  locale?: string;
}
export const FIRST_JOB_SESSION_PATTERN = /^concierge-[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function readFields(row: Record<string, unknown>): FirstJobReadRequest | undefined {
  if (
    (row.session_id !== undefined &&
      (typeof row.session_id !== 'string' || !FIRST_JOB_SESSION_PATTERN.test(row.session_id))) ||
    (row.locale !== undefined &&
      (typeof row.locale !== 'string' || row.locale.length > 32 || !row.locale.trim()))
  )
    return undefined;
  return {
    ...(row.session_id !== undefined ? { session_id: row.session_id as string } : {}),
    ...(row.locale !== undefined ? { locale: row.locale as string } : {}),
  };
}
export function parseFirstJobReadRequest(value: unknown): FirstJobReadRequest | undefined {
  if (!object(value) || Object.keys(value).some((key) => !['locale', 'session_id'].includes(key)))
    return undefined;
  return readFields(value);
}
export interface FirstJobArtifactReadRequest {
  session_id: string;
  request_id: string;
  revision: number;
  sha256: string;
}
/** A version selector, never a filesystem path or an authorization claim. */
export function parseFirstJobArtifactReadRequest(
  value: unknown
): FirstJobArtifactReadRequest | undefined {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) => !['session_id', 'request_id', 'revision', 'sha256'].includes(key)
    ) ||
    typeof value.session_id !== 'string' ||
    !FIRST_JOB_SESSION_PATTERN.test(value.session_id) ||
    typeof value.request_id !== 'string' ||
    !UUID_PATTERN.test(value.request_id) ||
    typeof value.revision !== 'string' ||
    !/^[1-9][0-9]{0,8}$/.test(value.revision) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    return undefined;
  return {
    session_id: value.session_id,
    request_id: value.request_id,
    revision: Number(value.revision),
    sha256: value.sha256,
  };
}

export function parseFirstJobRequest(value: unknown): FirstJobRequest | undefined {
  if (!object(value)) return undefined;
  const allowed =
    value.action === 'start'
      ? ['action', 'request_id', 'session_id', 'locale']
      : ['action', 'request_id', 'session_id', 'locale', 'artifactRevision'];
  const common = readFields(value);
  if (
    !common ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.request_id !== 'string' ||
    !UUID_PATTERN.test(value.request_id)
  )
    return undefined;
  if (value.action === 'start') return { ...common, action: 'start', request_id: value.request_id };
  const artifactRevision = parseFrontDeskArtifactRevisionInput(value.artifactRevision);
  if (value.action !== 'revise' || !artifactRevision) return undefined;
  return { ...common, action: 'revise', request_id: value.request_id, artifactRevision };
}

export interface FirstJobApprovalDecisionRequest {
  decision: 'approved' | 'rejected';
  display_digest: string;
  session_id: string;
}
export function parseFirstJobApprovalDecisionRequest(
  value: unknown
): FirstJobApprovalDecisionRequest | undefined {
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['decision', 'display_digest', 'session_id'].includes(key)) ||
    !['approved', 'rejected'].includes(String(value.decision)) ||
    typeof value.display_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.display_digest) ||
    typeof value.session_id !== 'string' ||
    !FIRST_JOB_SESSION_PATTERN.test(value.session_id)
  )
    return undefined;
  return {
    decision: value.decision as 'approved' | 'rejected',
    display_digest: value.display_digest,
    session_id: value.session_id,
  };
}

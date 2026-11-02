import {
  planServiceOperation,
  createServiceExecutionReceipt,
  persistServiceExecutionReceipt,
} from '@agent/core/service/service-harness';
import { executeInformationAssetCapture } from '@agent/core/information-assets/collector-capture';
import {
  executeInformationAssetWork,
  resolveInformationAssetMissionExecution,
  parseInformationAssetWorkBinding,
} from '@agent/core/information-assets/work';
import {
  getInformationAssetCollector,
  readInformationAssetObservation,
  assertInformationAssetCaptureOperation,
} from '@agent/core/information-assets/collector';
import {
  authorizeInformationAssetCapture,
  readInformationAssetCatalog,
} from '@agent/core/information-assets/catalog';
import { assertInformationAssetBinding } from '@agent/core/information-assets/access';
import { getWorkItem, listActiveWorkLeases } from '@agent/core/workforce/work-coordination';
import { ExternalOperationApprovalRequired } from '@agent/core/governance/external-operation';
import { resolveIdentityContext } from '@agent/core/authority';
import { informationArtifactHash } from '@agent/core/information-assets/completion';
import type { ServiceAction, ServiceActionExecutionOptions } from './service-actuator-helpers.js';
type ServicePort = (
  input: ServiceAction,
  onEvent?: (data: unknown) => void,
  options?: ServiceActionExecutionOptions
) => Promise<unknown>;
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const unwrap = (v: unknown): Obj => {
  const o = object(v);
  return o.data && typeof o.data === 'object' ? object(o.data) : o;
};
function bodyText(payload: unknown): string {
  const p = object(payload);
  const body = object(p.body);
  if (typeof body.data === 'string' && (p.mimeType === 'text/plain' || !p.mimeType))
    return Buffer.from(body.data, 'base64url').toString('utf8');
  return array(p.parts).map(bodyText).find(Boolean) ?? '';
}
/** Fixed compiler from admitted recipes to gated service calls. Source text has no routing authority. */
export async function runInformationAssetWork(
  params: Record<string, unknown>,
  service: ServicePort,
  options: ServiceActionExecutionOptions = {}
) {
  const text = (key: string): string => {
    const value = params[key];
    if (typeof value !== 'string' || !value) throw new Error('information_work_input:' + key);
    return value;
  };
  const input = {
    workItemId: text('work_item_id'),
    attemptId: text('attempt_id'),
    leaseId: text('lease_id'),
    dotId: text('dot_id'),
    actorId: text('actor_id'),
  };
  const item = getWorkItem(input.workItemId);
  const binding = parseInformationAssetWorkBinding(item?.metadata?.information_asset_work);
  const location = readInformationAssetCatalog(binding.observation.scope).locations.find(
    (l) => l.location_id === binding.observation.location_id
  );
  if (
    !location ||
    location.binding_id !== binding.observation.binding_id ||
    location.service_id !== binding.observation.service_id ||
    !location.enabled
  )
    throw new Error('information_work_location_changed');
  const assertClaim = () => {
    const activeLocation = readInformationAssetCatalog(binding.observation.scope).locations.find(
      (l) => l.location_id === location.location_id
    );
    if (JSON.stringify(activeLocation) !== JSON.stringify(location))
      throw new Error('information_work_location_changed');
    const current = getWorkItem(input.workItemId);
    const lease = listActiveWorkLeases().find((l) => l.lease_id === input.leaseId);
    if (
      !current ||
      current.status !== 'in_progress' ||
      current.lease_id !== input.leaseId ||
      current.current_attempt_id !== input.attemptId ||
      current.claimed_by_peer_id !== input.actorId ||
      !lease ||
      lease.status !== 'active' ||
      Date.parse(lease.expires_at) <= Date.now()
    )
      throw new Error('information_work_claim_expired');
    if (JSON.stringify(current.metadata?.information_asset_work) !== JSON.stringify(binding))
      throw new Error('information_work_binding_changed');
  };
  const context = {
    service_binding_id: location.binding_id,
    security_scope: {
      ...location.scope,
      mission_id: resolveIdentityContext().missionId ?? '',
      read_tiers: [location.tier],
      write_tier: location.tier,
      purpose: 'information-asset-work',
    },
  };
  const call = async (action: string, request: Obj) => {
    assertClaim();
    return service(
      {
        service_id: location.service_id,
        mode: 'PRESET',
        action,
        params: request,
        auth: 'secret-guard',
        context,
      },
      undefined,
      options
    );
  };
  const capture = async (action: string, request: Obj) => {
    assertInformationAssetCaptureOperation(location.service_id, action);
    await authorizeInformationAssetCapture(location.scope, location.location_id, action);
    assertClaim();
    return unwrap(
      await executeInformationAssetCapture(location, {
        service_id: location.service_id,
        action,
        params: request,
      })
    );
  };
  const load = () => {
    const observation = readInformationAssetObservation(location, binding.observation.event_id);
    if (!observation) throw new Error('information_work_observation_unavailable');
    return observation;
  };
  const jiraVars = () => ({
    domain: location.selectors.domain,
    issue_key: load().data.issue_key ?? binding.observation.subject_id,
  });
  const threadFacts = async () => {
    const data = load().data;
    const id = data.review_thread_id;
    const number = Number(data.number);
    if (
      typeof id !== 'string' ||
      !id ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      typeof location.selectors.owner !== 'string' ||
      typeof location.selectors.repo !== 'string'
    )
      return undefined;
    let after: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await capture('get_review_threads', {
        query: {
          query:
            'query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$after){nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}',
          variables: JSON.stringify({
            owner: location.selectors.owner,
            repo: location.selectors.repo,
            number,
            ...(after ? { after } : {}),
          }),
        },
      });
      const pull = object(object(result.repository).pullRequest);
      if (pull.headRefOid !== data.head_sha) return undefined;
      const threads = object(pull.reviewThreads);
      const thread = array(threads.nodes)
        .map(object)
        .find((t) => t.id === id);
      if (thread) return thread;
      const info = object(threads.pageInfo);
      if (info.hasNextPage !== true) return undefined;
      if (typeof info.endCursor !== 'string' || !info.endCursor || seen.has(info.endCursor))
        return undefined;
      seen.add(info.endCursor);
      after = info.endCursor;
    }
    return undefined;
  };
  return executeInformationAssetWork(input, {
    tier: location.tier,
    loadObservation: async () => {
      await authorizeInformationAssetCapture(
        location.scope,
        location.location_id,
        getInformationAssetCollector(location.collector_id).actions[0]
      );
      return load();
    },
    hostApply: async (recipe, b, prepared) => {
      assertInformationAssetBinding(location);
      if (!resolveIdentityContext().missionId) return { status: 'approval_required' };
      resolveInformationAssetMissionExecution(input.workItemId);
      const data = load().data;
      let action: string;
      let request: Obj;
      switch (recipe.action) {
        case 'approve_issue': {
          const id = String(object(data.approval).id ?? '');
          if (location.service_id !== 'jira' || !/^[a-zA-Z0-9_-]+$/.test(id))
            return { status: 'approval_required' };
          action = 'answer_request_approval';
          request = { vars: { ...jiraVars(), approval_id: id }, decision: 'approve' };
          break;
        }
        case 'follow_up':
          if (
            location.service_id !== 'google-workspace' ||
            typeof prepared.params.body !== 'string' ||
            !prepared.params.body.trim()
          )
            return { status: 'approval_required' };
          action = 'gmail_reply';
          request = { message_id: b.observation.subject_id, body: prepared.params.body };
          break;
        case 'resolve_review': {
          if (location.service_id !== 'github' || !(await threadFacts()))
            return { status: 'approval_required' };
          action = 'resolve_review_thread';
          request = { thread_id: data.review_thread_id };
          break;
        }
        case 'resolve_overdue':
          if (
            location.service_id !== 'jira' ||
            typeof location.selectors.overdue_transition_id !== 'string' ||
            typeof location.selectors.overdue_status_id !== 'string'
          )
            return { status: 'approval_required' };
          action = 'transition_issue';
          request = { vars: jiraVars(), transition_id: location.selectors.overdue_transition_id };
          break;
        case 'request_information':
          if (
            location.service_id !== 'jira' ||
            typeof prepared.params.body !== 'string' ||
            !prepared.params.body.trim()
          )
            return { status: 'approval_required' };
          action = 'add_comment';
          request = { vars: jiraVars(), body: prepared.params.body };
          break;
        default:
          throw new Error('information_work_action_not_external');
      }
      const plan = planServiceOperation(location.service_id, action, request);
      const receipt = (status: 'succeeded' | 'failed' | 'approval_required', result: unknown) =>
        persistServiceExecutionReceipt(
          createServiceExecutionReceipt(
            {
              ...plan,
              inputs: {
                work_key: b.work_key,
                request_sha256: informationArtifactHash(JSON.stringify(request)),
              },
            },
            result,
            {
              status,
              ...(status === 'failed'
                ? { error: 'External result is uncertain; independent readback required' }
                : {}),
            }
          )
        ).receipt_id;
      try {
        const result = await call(action, request);
        return { status: 'applied', execution_receipt_id: receipt('succeeded', result) };
      } catch (error) {
        if (error instanceof ExternalOperationApprovalRequired)
          return {
            status: 'approval_required',
            approval_request_id: error.approval.requestId,
            execution_receipt_id: receipt('approval_required', undefined),
          };
        if (error instanceof Error && /^\[OP_PREFLIGHT_(ASK|BLOCK)\]/.test(error.message))
          return {
            status: 'approval_required',
            execution_receipt_id: receipt('approval_required', undefined),
          };
        if (
          error &&
          typeof error === 'object' &&
          'adfControlFlow' in error &&
          error.adfControlFlow === 'suspend'
        )
          throw error;
        return { status: 'unknown', execution_receipt_id: receipt('failed', undefined) };
      }
    },
    readback: async (recipe, b) => {
      const data = load().data;
      let evidence: unknown;
      let verified = false;
      const expectedBody = getWorkItem(input.workItemId)?.metadata
        ?.information_asset_expected_body_sha256;
      switch (recipe.action) {
        case 'approve_issue': {
          const id = String(object(data.approval).id ?? '');
          const row = await capture('get_request_approval', {
            vars: { ...jiraVars(), approval_id: id },
          });
          evidence = row;
          verified = String(row.id) === id && row.finalDecision === 'approved';
          break;
        }
        case 'follow_up': {
          if (typeof data.threadId !== 'string') break;
          const row = await capture('gmail_thread_get', {
            params: { userId: 'me', id: data.threadId, format: 'full' },
          });
          evidence = row;
          verified = array(row.messages)
            .map(object)
            .some(
              (m) =>
                m.threadId === data.threadId &&
                m.id !== b.observation.subject_id &&
                array(m.labelIds).includes('SENT') &&
                informationArtifactHash(bodyText(m.payload)) === expectedBody
            );
          break;
        }
        case 'resolve_review': {
          const thread = await threadFacts();
          evidence = thread;
          verified = thread?.isResolved === true;
          break;
        }
        case 'resolve_overdue': {
          const row = await capture('get_issue', { vars: jiraVars() });
          evidence = row;
          verified =
            row.key === b.observation.subject_id &&
            object(object(row.fields).status).id === location.selectors.overdue_status_id;
          break;
        }
        case 'request_information': {
          const row = await capture('get_issue_comments', {
            vars: jiraVars(),
            query: { maxResults: 100, orderBy: '-created' },
          });
          evidence = row;
          verified = array(row.comments)
            .map(object)
            .some((c) => {
              const paragraphs = array(object(c.body).content).map(object);
              const text = paragraphs
                .flatMap((p) => array(p.content).map(object))
                .map((t) => (typeof t.text === 'string' ? t.text : ''))
                .join('');
              return informationArtifactHash(text) === expectedBody;
            });
          break;
        }
      }
      return {
        scope: b.observation.scope,
        subject_id: b.observation.subject_id,
        change_id: b.observation.change_id,
        verified,
        evidence_sha256: informationArtifactHash(JSON.stringify(evidence ?? null)),
      };
    },
  });
}

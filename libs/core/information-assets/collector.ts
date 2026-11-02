import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { safeExistsSync } from '../secure-io.js';
import { readJson, writeJson } from '../foundation/json.js';
import { withLock } from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import { dotStatePath } from '../dot/dot-state-paths.js';
import { assertInformationAssetCaptureOperation } from './collector-capture-policy.js';
export { assertInformationAssetCaptureOperation } from './collector-capture-policy.js';
import type {
  InformationAssetLocation,
  InformationAssetObservation,
  InformationAssetCoverage,
  InformationAssetServiceCall,
} from './types.js';
import type { CollectorCursor, CollectorPage, InformationAssetCollector } from './provider.js';
import { CollectorFullSyncRequired } from './provider.js';
import { gmailHistoryCollector, gmailFollowupCollector } from './provider-gmail.js';
import {
  githubReviewCollector,
  jiraIssueCollector,
  jiraApprovalCollector,
} from './provider-code-work.js';

const collectors: readonly InformationAssetCollector[] = [
  gmailHistoryCollector,
  gmailFollowupCollector,
  githubReviewCollector,
  jiraIssueCollector,
  jiraApprovalCollector,
];
export function listInformationAssetCollectors(): readonly InformationAssetCollector[] {
  return [...collectors];
}
export function getInformationAssetCollector(id: string): InformationAssetCollector {
  const collector = collectors.find((item) => item.id === id);
  if (!collector) throw new Error('information_asset_collector_unknown:' + id);
  return collector;
}
export function canonicalInformationJson(value: unknown): string {
  if (value === undefined) throw new Error('information_asset_undefined_json');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalInformationJson).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => JSON.stringify(key) + ':' + canonicalInformationJson(v))
      .join(',') +
    '}'
  );
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalInformationJson(value)).digest('hex');
}
interface PendingPage {
  observations: InformationAssetObservation[];
  accepted: string[];
  next: CollectorCursor;
  complete: boolean;
}
interface CollectionState {
  version: 1;
  identity: string;
  cursor: CollectorCursor;
  pending?: PendingPage;
  coverage?: InformationAssetCoverage;
}
class CollectorBudgetExhausted extends Error {}
export interface InformationAssetCollectionDeps {
  serviceCall: InformationAssetServiceCall;
  /** Must re-read scoped catalog and binding grant immediately before every call. */
  authorize: (
    location: InformationAssetLocation,
    operation: string
  ) => Promise<InformationAssetLocation>;
  /** Resolves only after durable acceptance, including idempotent duplicate acceptance. */
  publish: (observation: InformationAssetObservation) => Promise<void> | void;
  rootDir?: string;
  maxPages?: number;
  now?: () => Date;
  timeoutMs?: number;
  maxRequests?: number;
  wallClockMs?: number;
}
export function informationAssetCollectionStatePath(
  location: InformationAssetLocation,
  rootDir = pathResolver.rootDir()
): string {
  if (location.tier !== 'confidential')
    throw new Error('information_asset_personal_owner_required');
  return path.resolve(
    rootDir,
    dotStatePath(
      { scope: { ...location.scope, tier: location.tier } },
      'information-assets',
      'collections',
      location.location_id + '.json'
    )
  );
}
function identity(location: InformationAssetLocation): string {
  return hash({ location, adapter_version: 1 });
}
function loadState(file: string, expected: string): CollectionState {
  if (!safeExistsSync(file)) return { version: 1, identity: expected, cursor: {} };
  const state = readJson<CollectionState>(file, { maxSizeMB: 16 });
  if (
    !state ||
    state.version !== 1 ||
    state.identity !== expected ||
    !state.cursor ||
    typeof state.cursor !== 'object'
  )
    throw new Error('information_asset_checkpoint_identity_or_schema_mismatch');
  for (const value of Object.values(state.cursor))
    if (value !== undefined && typeof value !== 'string')
      throw new Error('information_asset_checkpoint_corrupt');
  if (
    state.pending &&
    (!Array.isArray(state.pending.observations) ||
      !Array.isArray(state.pending.accepted) ||
      typeof state.pending.complete !== 'boolean' ||
      !state.pending.next ||
      state.pending.observations.length > 1000 ||
      state.pending.observations.some(
        (item) => !item || typeof item.event_id !== 'string' || !item.data
      ) ||
      state.pending.accepted.some(
        (id) => !state.pending!.observations.some((item) => item.event_id === id)
      ))
  )
    throw new Error('information_asset_pending_page_corrupt');
  return state;
}
function persist(file: string, state: CollectionState): void {
  writeJson(file, state);
}
export function readInformationAssetCollectionCoverage(
  location: InformationAssetLocation,
  rootDir?: string
): InformationAssetCoverage | undefined {
  return loadState(informationAssetCollectionStatePath(location, rootDir), identity(location))
    .coverage;
}
function observationPath(
  location: InformationAssetLocation,
  eventId: string,
  rootDir?: string
): string {
  if (!/^[a-f0-9]{64}$/.test(eventId)) throw new Error('information_asset_invalid_event_id');
  return path.join(
    path.dirname(informationAssetCollectionStatePath(location, rootDir)),
    'observations',
    eventId + '.json'
  );
}
export function readInformationAssetObservation(
  location: InformationAssetLocation,
  eventId: string,
  rootDir?: string
): InformationAssetObservation | undefined {
  const file = observationPath(location, eventId, rootDir);
  if (!safeExistsSync(file)) return undefined;
  const row = readJson<{
    accepted: boolean;
    identity: string;
    observation: InformationAssetObservation;
  }>(file, { maxSizeMB: 1 });
  const observation = row.observation;
  if (
    !row.accepted ||
    row.identity !== identity(location) ||
    !observation ||
    observation.event_id !== eventId ||
    observation.location_id !== location.location_id ||
    observation.binding_id !== location.binding_id ||
    canonicalInformationJson(observation.scope) !== canonicalInformationJson(location.scope) ||
    observation.content_sha256 !== hash(observation.data)
  )
    throw new Error('information_asset_observation_integrity_failed');
  assertObservation(location, observation);
  return observation;
}
function assertObservation(
  location: InformationAssetLocation,
  observation: InformationAssetObservation
): void {
  if (
    !observation ||
    !observation.data ||
    Array.isArray(observation.data) ||
    typeof observation.subject_id !== 'string' ||
    typeof observation.change_id !== 'string' ||
    typeof observation.event_type !== 'string' ||
    observation.location_id !== location.location_id ||
    observation.binding_id !== location.binding_id ||
    observation.service_id !== location.service_id ||
    observation.asset_type !== location.asset_type ||
    canonicalInformationJson(observation.scope) !== canonicalInformationJson(location.scope) ||
    observation.content_sha256 !== hash(observation.data) ||
    observation.event_id !==
      hash({
        scope: location.scope,
        location: location.location_id,
        binding: location.binding_id,
        subject: observation.subject_id,
        change: observation.change_id,
        type: observation.event_type,
      })
  )
    throw new Error('information_asset_observation_integrity_failed');
}
function observations(
  location: InformationAssetLocation,
  page: CollectorPage,
  now: string
): InformationAssetObservation[] {
  return page.subjects.map((subject) => {
    if (!subject.subject_id || !subject.change_id || !subject.event_type)
      throw new Error('information_asset_subject_identity_required');
    const content_sha256 = hash(subject.data);
    const event_id = hash({
      scope: location.scope,
      location: location.location_id,
      binding: location.binding_id,
      subject: subject.subject_id,
      change: subject.change_id,
      type: subject.event_type,
    });
    return {
      ...subject,
      scope: location.scope,
      asset_type: location.asset_type,
      location_id: location.location_id,
      binding_id: location.binding_id,
      service_id: location.service_id,
      event_id,
      observed_at: now,
      content_sha256,
    };
  });
}
export async function collectInformationAsset(
  location: InformationAssetLocation,
  deps: InformationAssetCollectionDeps
): Promise<InformationAssetCoverage> {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const file = informationAssetCollectionStatePath(location, deps.rootDir);
  return withLock('information-asset-collection:' + hash(file), async () => {
    let state: CollectionState;
    try {
      state = loadState(file, identity(location));
    } catch (error) {
      return {
        status: 'failed',
        observed_at: now(),
        page_count: 0,
        accepted_count: 0,
        reason: String(error),
      };
    }
    let pageCount = 0,
      acceptedCount = 0;
    let requestCount = 0;
    const started = performance.now();
    const finish = (status: InformationAssetCoverage['status'], reason?: string) => {
      const coverage: InformationAssetCoverage = {
        status,
        observed_at: now(),
        page_count: pageCount,
        accepted_count: acceptedCount,
        ...(state.cursor.checkpoint ? { covered_through: state.cursor.checkpoint } : {}),
        ...(reason ? { reason } : {}),
      };
      state.coverage = coverage;
      persist(file, state);
      return coverage;
    };
    try {
      if (!location.enabled) throw new Error('information_asset_location_disabled');
      const adapter = getInformationAssetCollector(location.collector_id);
      if (
        adapter.service_id !== location.service_id ||
        !adapter.asset_types.includes(location.asset_type)
      )
        throw new Error('information_asset_collector_location_mismatch');
      const requestBudget = deps.maxRequests ?? 500;
      const wallClockBudget = deps.wallClockMs ?? 30000;
      if (
        !Number.isInteger(requestBudget) ||
        requestBudget < 1 ||
        requestBudget > 10000 ||
        !Number.isInteger(wallClockBudget) ||
        wallClockBudget < 1 ||
        wallClockBudget > 300000
      )
        throw new Error('information_asset_invalid_capture_budget');
      const budget = deps.maxPages ?? 10;
      if (!Number.isInteger(budget) || budget < 1 || budget > 100)
        throw new Error('information_asset_invalid_page_budget');
      // Validate current registration even when resuming a persisted page without a network call.
      const verified = await deps.authorize(location, adapter.actions[0]!);
      if (canonicalInformationJson(verified) !== canonicalInformationJson(location))
        throw new Error('information_asset_registered_location_changed');
      while (pageCount < budget) {
        if (!state.pending) {
          const before = canonicalInformationJson(state.cursor);
          const page = await adapter.collect(
            location,
            state.cursor,
            async (action, params) => {
              if (requestCount >= requestBudget)
                throw new CollectorBudgetExhausted('request_budget_exhausted');
              if (performance.now() - started >= wallClockBudget)
                throw new CollectorBudgetExhausted('wall_clock_budget_exhausted');
              requestCount++;
              if (!adapter.actions.includes(action))
                throw new Error('information_asset_adapter_operation_denied');
              assertInformationAssetCaptureOperation(location.service_id, action);
              const current = await deps.authorize(location, action);
              if (canonicalInformationJson(current) !== canonicalInformationJson(location))
                throw new Error('information_asset_registered_location_changed');
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  deps.serviceCall({ service_id: location.service_id, action, params }),
                  new Promise<never>((_, reject) => {
                    const remaining = Math.max(1, wallClockBudget - (performance.now() - started));
                    const perCall = deps.timeoutMs ?? 20000;
                    timer = setTimeout(
                      () =>
                        reject(
                          remaining <= perCall
                            ? new CollectorBudgetExhausted('wall_clock_budget_exhausted')
                            : new Error('information_asset_capture_timeout')
                        ),
                      Math.min(perCall, remaining)
                    );
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            },
            deps.now?.() ?? new Date()
          );
          if (!page.complete && canonicalInformationJson(page.next) === before)
            throw new Error('information_asset_nonadvancing_page');
          state.pending = {
            observations: observations(location, page, now()),
            accepted: [],
            next: page.next,
            complete: page.complete,
          };
          if (Buffer.byteLength(JSON.stringify(state.pending)) > 15 * 1024 * 1024)
            throw new Error('information_asset_pending_page_size_exceeded');
          persist(file, state);
        }
        const pending = state.pending;
        for (const observation of pending.observations) assertObservation(location, observation);
        for (const observation of pending.observations) {
          if (pending.accepted.includes(observation.event_id)) continue;
          const publicationLocation = await deps.authorize(location, adapter.actions[0]!);
          if (canonicalInformationJson(publicationLocation) !== canonicalInformationJson(location))
            throw new Error('information_asset_registered_location_changed');
          const archive = observationPath(location, observation.event_id, deps.rootDir);
          if (safeExistsSync(archive)) {
            const existing = readJson<{
              accepted: boolean;
              identity: string;
              observation: InformationAssetObservation;
            }>(archive, { maxSizeMB: 1 });
            if (
              existing.identity !== identity(location) ||
              existing.observation.content_sha256 !== observation.content_sha256 ||
              hash(existing.observation.data) !== observation.content_sha256
            )
              throw new Error('information_asset_event_content_conflict');
            if (existing.accepted) {
              pending.accepted.push(observation.event_id);
              persist(file, state);
              continue;
            }
          }
          writeJson(archive, { accepted: false, identity: identity(location), observation });
          await deps.publish(observation);
          writeJson(archive, { accepted: true, identity: identity(location), observation });
          pending.accepted.push(observation.event_id);
          acceptedCount++;
          persist(file, state);
        }
        state.cursor = pending.next;
        delete state.pending;
        pageCount++;
        persist(file, state);
        if (pending.complete) return finish('complete');
      }
      return finish('partial', 'page_budget_exhausted');
    } catch (error) {
      return finish(
        error instanceof CollectorFullSyncRequired
          ? 'full_sync_required'
          : error instanceof CollectorBudgetExhausted
            ? 'partial'
            : 'failed',
        String(error)
      );
    }
  });
}

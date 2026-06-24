import { loadPeerNetworkCatalog, type PeerNetworkPeerRecord } from './peer-messaging.js';
import { appendGovernedArtifactJsonl } from './artifact-store.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import type {
  MeshCapabilityAdvertisement,
  MeshPeerPresence,
  MeshPeerPresenceCapacity,
  MeshPeerRegistration,
  MeshReceiveMode,
  MeshRequestKind,
  MeshTargetSelector,
} from './mesh-hub-contract.js';

const DEFAULT_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub';
const ALLOWED_REGISTRATION_AUTHORITIES = new Set(['infrastructure_sentinel', 'mission_controller']);

export interface MeshPeerDirectoryPolicyContext {
  tenant_id: string;
  now?: string | Date;
  request_kind?: MeshRequestKind;
}

export interface MeshPeerDirectoryEntry {
  peer_id: string;
  tenant_id?: string;
  endpoint_ref?: string;
  key_ref?: string;
  status: MeshPeerRegistration['status'];
  registered_at?: string;
  revoked_at?: string;
  source: 'live' | 'bootstrap';
  presence?: MeshPeerPresence | null;
  capabilities: MeshCapabilityAdvertisement[];
  allowed_request_kinds: MeshRequestKind[];
}

export interface RegisterMeshPeerInput {
  peer_id: string;
  tenant_id: string;
  endpoint_ref: string;
  key_ref: string;
  registered_at?: string | Date;
  revoked_at?: string | Date;
  status?: MeshPeerRegistration['status'];
  allowed_request_kinds?: MeshRequestKind[];
  authority_role: string;
}

export interface RecordMeshHeartbeatInput {
  peer_id: string;
  tenant_id: string;
  heartbeat_at?: string | Date;
  expires_at: string | Date;
  health?: MeshPeerPresence['health'];
  capacity?: Partial<MeshPeerPresenceCapacity>;
  receive_modes?: MeshReceiveMode[];
}

export interface AdvertiseMeshCapabilitiesInput {
  peer_id: string;
  tenant_id: string;
  capability_id: string;
  version: string;
  roles: string[];
  request_kinds: MeshRequestKind[];
  approval_policy?: MeshCapabilityAdvertisement['approval_policy'];
  visibility?: MeshCapabilityAdvertisement['visibility'];
  advertised_at?: string | Date;
}

function meshHubRuntimeRoot(): string {
  return process.env.KYBERION_MESH_HUB_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT;
}

function runtimePath(segment: string): string {
  return `${meshHubRuntimeRoot()}/${segment}`;
}

function normalizeIso(value?: string | Date): string {
  const input = value ?? new Date();
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid_iso_timestamp:${String(value)}`);
  }
  return date.toISOString();
}

function readJsonlRecords<T>(logicalPath: string): T[] {
  if (!safeExistsSync(logicalPath)) return [];
  const raw = String(safeReadFile(logicalPath, { encoding: 'utf8' }) ?? '');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function latestByPeerId<T extends { peer_id: string }>(records: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const record of records) {
    latest.set(record.peer_id, record);
  }
  return latest;
}

function latestCapabilityKey(record: MeshCapabilityAdvertisement): string {
  return `${record.peer_id}::${record.capability_id}`;
}

function latestCapabilityAds(records: MeshCapabilityAdvertisement[]): Map<string, MeshCapabilityAdvertisement> {
  const latest = new Map<string, MeshCapabilityAdvertisement>();
  for (const record of records) {
    latest.set(latestCapabilityKey(record), record);
  }
  return latest;
}

function normalizeSelector(selector: MeshTargetSelector): MeshTargetSelector {
  switch (selector.kind) {
    case 'peer':
      return { kind: 'peer', peer_id: String(selector.peer_id || '').trim() };
    case 'role':
      return { kind: 'role', role: String(selector.role || '').trim() };
    case 'capability':
      return {
        kind: 'capability',
        capability_id: String(selector.capability_id || '').trim(),
        ...(selector.version ? { version: String(selector.version).trim() } : {}),
      };
    case 'topic':
      return { kind: 'topic', topic: String(selector.topic || '').trim() };
    default:
      return selector;
  }
}

function currentPresence(now: string, presence: MeshPeerPresence | undefined): MeshPeerPresence | null {
  if (!presence) return null;
  if (presence.expires_at <= now) return null;
  return presence;
}

function normalizeHeartbeatCapacity(capacity?: Partial<MeshPeerPresenceCapacity>): MeshPeerPresenceCapacity {
  return {
    accepting_new_work: capacity?.accepting_new_work ?? true,
    available_slots: capacity?.available_slots ?? 1,
    max_inflight: capacity?.max_inflight ?? 1,
  };
}

function loadRegistrations(): MeshPeerRegistration[] {
  return readJsonlRecords<MeshPeerRegistration>(runtimePath('registrations.jsonl'));
}

function loadPresence(): MeshPeerPresence[] {
  return readJsonlRecords<MeshPeerPresence>(runtimePath('presence.jsonl'));
}

function loadCapabilities(): MeshCapabilityAdvertisement[] {
  return readJsonlRecords<MeshCapabilityAdvertisement>(runtimePath('capabilities.jsonl'));
}

function appendRegistration(record: MeshPeerRegistration): string {
  return appendGovernedArtifactJsonl('infrastructure_sentinel', runtimePath('registrations.jsonl'), record);
}

function appendPresence(record: MeshPeerPresence): string {
  return appendGovernedArtifactJsonl('infrastructure_sentinel', runtimePath('presence.jsonl'), record);
}

function appendCapability(record: MeshCapabilityAdvertisement): string {
  return appendGovernedArtifactJsonl('infrastructure_sentinel', runtimePath('capabilities.jsonl'), record);
}

function resolveBootstrapPeer(peerId: string): MeshPeerDirectoryEntry | null {
  const catalog = loadPeerNetworkCatalog();
  const peer = catalog?.peers?.find((entry: PeerNetworkPeerRecord) => entry.peer_id === peerId) || null;
  if (!peer) return null;

  return {
    peer_id: peer.peer_id,
    endpoint_ref: peer.base_url,
    key_ref: peer.shared_secret,
    status: 'enrolled',
    source: 'bootstrap',
    capabilities: [],
    allowed_request_kinds: [],
  };
}

function buildDirectoryEntry(
  registration: MeshPeerRegistration,
  presence: MeshPeerPresence | null,
  capabilities: MeshCapabilityAdvertisement[],
): MeshPeerDirectoryEntry {
  return {
    peer_id: registration.peer_id,
    tenant_id: registration.tenant_id,
    endpoint_ref: registration.endpoint_ref,
    key_ref: registration.key_ref,
    status: registration.status,
    registered_at: registration.registered_at,
    ...(registration.revoked_at ? { revoked_at: registration.revoked_at } : {}),
    source: 'live',
    presence,
    capabilities,
    allowed_request_kinds: registration.allowed_request_kinds || [],
  };
}

function buildAllDirectoryEntries(now?: string | Date): MeshPeerDirectoryEntry[] {
  const normalizedNow = normalizeIso(now);
  const registrations = latestByPeerId(loadRegistrations());
  const presences = latestByPeerId(loadPresence());
  const capabilityMap = latestCapabilityAds(loadCapabilities());

  return [...registrations.values()]
    .map((registration) => {
      const presence = currentPresence(normalizedNow, presences.get(registration.peer_id) || undefined);
      const capabilities = [...capabilityMap.values()]
        .filter((record) => record.peer_id === registration.peer_id)
        .sort((left, right) => left.capability_id.localeCompare(right.capability_id) || left.version.localeCompare(right.version));
      return buildDirectoryEntry(registration, presence, capabilities);
    })
    .sort((left, right) => left.peer_id.localeCompare(right.peer_id));
}

function getCurrentSnapshot(peerId: string): MeshPeerDirectoryEntry | null {
  const registrations = latestByPeerId(loadRegistrations());
  const registration = registrations.get(peerId) || null;
  if (!registration) {
    return resolveBootstrapPeer(peerId);
  }

  const presence = currentPresence(normalizeIso(), latestByPeerId(loadPresence()).get(peerId) || undefined);
  const capabilityMap = latestCapabilityAds(loadCapabilities());
  const capabilities = [...capabilityMap.values()].filter((record) => record.peer_id === peerId);
  return buildDirectoryEntry(registration, presence, capabilities);
}

function peerMatchesSelector(
  entry: MeshPeerDirectoryEntry,
  selector: MeshTargetSelector,
): boolean {
  switch (selector.kind) {
    case 'peer':
      return entry.peer_id === selector.peer_id;
    case 'role':
      return entry.capabilities.some((capability) => capability.roles.includes(selector.role));
    case 'capability':
      return entry.capabilities.some((capability) =>
        capability.capability_id === selector.capability_id &&
        (!selector.version || capability.version === selector.version),
      );
    case 'topic':
      return false;
    default:
      return false;
  }
}

function sameTenant(entry: MeshPeerDirectoryEntry, tenantId: string): boolean {
  return entry.tenant_id === tenantId;
}

function isEligibleEntry(
  entry: MeshPeerDirectoryEntry,
  selector: MeshTargetSelector,
  policyContext: MeshPeerDirectoryPolicyContext,
): boolean {
  if (!entry.tenant_id) return false;
  if (!sameTenant(entry, policyContext.tenant_id)) return false;
  if (entry.status !== 'enrolled') return false;
  const presence = currentPresence(normalizeIso(policyContext.now), entry.presence || undefined);
  if (!presence) return false;
  if (policyContext.request_kind) {
    const requestAuthorized = entry.capabilities.some((capability) => capability.request_kinds.includes(policyContext.request_kind as MeshRequestKind));
    if (!requestAuthorized) return false;
  }
  return peerMatchesSelector(entry, selector);
}

export function registerMeshPeer(input: RegisterMeshPeerInput): MeshPeerRegistration {
  if (!ALLOWED_REGISTRATION_AUTHORITIES.has(input.authority_role)) {
    throw new Error(`registration_authority_denied:${input.authority_role}`);
  }
  const peer_id = String(input.peer_id || '').trim();
  const tenant_id = String(input.tenant_id || '').trim();
  const endpoint_ref = String(input.endpoint_ref || '').trim();
  const key_ref = String(input.key_ref || '').trim();
  if (!peer_id || !tenant_id || !endpoint_ref || !key_ref) {
    throw new Error('registration_missing_required_fields');
  }

  const registration: MeshPeerRegistration = {
    kind: 'mesh-peer-registration',
    peer_id,
    tenant_id,
    endpoint_ref,
    key_ref,
    status: input.status || 'enrolled',
    registered_at: normalizeIso(input.registered_at),
    ...(input.revoked_at ? { revoked_at: normalizeIso(input.revoked_at) } : {}),
    ...(input.allowed_request_kinds ? { allowed_request_kinds: [...input.allowed_request_kinds] } : {}),
  };
  appendRegistration(registration);
  return registration;
}

export function recordMeshHeartbeat(input: RecordMeshHeartbeatInput): MeshPeerPresence {
  const peer_id = String(input.peer_id || '').trim();
  const tenant_id = String(input.tenant_id || '').trim();
  if (!peer_id || !tenant_id) {
    throw new Error('heartbeat_missing_required_fields');
  }

  const registration = latestByPeerId(loadRegistrations()).get(peer_id) || null;
  if (!registration || registration.status !== 'enrolled') {
    throw new Error(`peer_not_enrolled:${peer_id}`);
  }
  if (registration.tenant_id !== tenant_id) {
    throw new Error(`tenant_mismatch:${peer_id}`);
  }

  const presence: MeshPeerPresence = {
    kind: 'mesh-peer-presence',
    peer_id,
    tenant_id,
    heartbeat_at: normalizeIso(input.heartbeat_at),
    expires_at: normalizeIso(input.expires_at),
    health: input.health || 'healthy',
    capacity: normalizeHeartbeatCapacity(input.capacity),
    receive_modes: input.receive_modes && input.receive_modes.length ? [...input.receive_modes] : ['request'],
  };
  appendPresence(presence);
  return presence;
}

export function advertiseMeshCapabilities(input: AdvertiseMeshCapabilitiesInput): MeshCapabilityAdvertisement {
  const peer_id = String(input.peer_id || '').trim();
  const tenant_id = String(input.tenant_id || '').trim();
  if (!peer_id || !tenant_id) {
    throw new Error('capability_advertisement_missing_required_fields');
  }

  const registration = latestByPeerId(loadRegistrations()).get(peer_id) || null;
  if (!registration || registration.status !== 'enrolled') {
    throw new Error(`peer_not_enrolled:${peer_id}`);
  }
  if (registration.tenant_id !== tenant_id) {
    throw new Error(`tenant_mismatch:${peer_id}`);
  }

  const allowlist = new Set(registration.allowed_request_kinds || []);
  if (!allowlist.size) {
    throw new Error(`peer_has_no_request_allowlist:${peer_id}`);
  }
  for (const requestKind of input.request_kinds) {
    if (!allowlist.has(requestKind)) {
      throw new Error(`capability_outside_allowlist:${peer_id}:${input.capability_id}`);
    }
  }

  const capability: MeshCapabilityAdvertisement = {
    kind: 'mesh-capability-advertisement',
    capability_id: String(input.capability_id || '').trim(),
    version: String(input.version || '').trim(),
    peer_id,
    tenant_id,
    roles: [...input.roles],
    request_kinds: [...input.request_kinds],
    approval_policy: input.approval_policy || {
      requires_explicit_acceptance: true,
      requires_local_validation: true,
      requires_policy_check: true,
    },
    visibility: input.visibility || 'tenant',
    advertised_at: normalizeIso(input.advertised_at),
  };
  if (!capability.capability_id || !capability.version) {
    throw new Error('capability_advertisement_missing_required_fields');
  }
  appendCapability(capability);
  return capability;
}

export function resolveMeshPeer(peerId: string): MeshPeerDirectoryEntry | null {
  const normalizedPeerId = String(peerId || '').trim();
  if (!normalizedPeerId) return null;

  const snapshot = getCurrentSnapshot(normalizedPeerId);
  if (snapshot) return snapshot;
  return null;
}

export function listEligibleMeshPeers(
  selector: MeshTargetSelector,
  policyContext: MeshPeerDirectoryPolicyContext,
): MeshPeerDirectoryEntry[] {
  const normalizedSelector = normalizeSelector(selector);
  if (normalizedSelector.kind === 'topic') {
    return [];
  }

  const now = normalizeIso(policyContext.now);
  const registrations = latestByPeerId(loadRegistrations());
  const presences = latestByPeerId(loadPresence());
  const capabilityMap = latestCapabilityAds(loadCapabilities());

  const entries = [...registrations.values()].map((registration) => {
    const presence = currentPresence(now, presences.get(registration.peer_id) || undefined);
    const capabilities = [...capabilityMap.values()]
      .filter((record) => record.peer_id === registration.peer_id)
      .sort((left, right) => left.capability_id.localeCompare(right.capability_id) || left.version.localeCompare(right.version));
    return buildDirectoryEntry(registration, presence, capabilities);
  });

  return entries
    .filter((entry) => isEligibleEntry(entry, normalizedSelector, { tenant_id: policyContext.tenant_id, now }))
    .sort((left, right) => left.peer_id.localeCompare(right.peer_id));
}

export function listMeshPeerDirectoryEntries(now?: string | Date): MeshPeerDirectoryEntry[] {
  return buildAllDirectoryEntries(now);
}

export function expireMeshPresence(now: string | Date): MeshPeerDirectoryEntry[] {
  const normalizedNow = normalizeIso(now);
  const registrations = latestByPeerId(loadRegistrations());
  const presences = latestByPeerId(loadPresence());
  const capabilityMap = latestCapabilityAds(loadCapabilities());

  return [...presences.values()]
    .filter((presence) => presence.expires_at <= normalizedNow)
    .map((presence) => {
      const registration = registrations.get(presence.peer_id);
      if (!registration) {
        return null;
      }
      const capabilities = [...capabilityMap.values()].filter((record) => record.peer_id === registration.peer_id);
      return buildDirectoryEntry(registration, null, capabilities);
    })
    .filter((entry): entry is MeshPeerDirectoryEntry => Boolean(entry))
    .sort((left, right) => left.peer_id.localeCompare(right.peer_id));
}

export function listMeshPeerRegistrationRecords(): MeshPeerRegistration[] {
  return loadRegistrations();
}

export function listMeshPeerPresenceRecords(): MeshPeerPresence[] {
  return loadPresence();
}

export function listMeshPeerCapabilityRecords(): MeshCapabilityAdvertisement[] {
  return loadCapabilities();
}

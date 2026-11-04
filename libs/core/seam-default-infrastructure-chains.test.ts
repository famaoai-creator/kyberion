// Generic saved seam default (KYBERION_SEAM_DEFAULTS) on the infrastructure
// chain seams: with no explicit selector the saved provider leads the governed
// default chain; an explicit selector still wins; a saved default naming an
// unregistered provider falls back to the governed chain. trace-exporter is a
// fan-out seam — the saved default only reorders delivery, never disables.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_LEASE_BACKEND_ID,
  registerLeaseBackend,
  resolveLeaseBackend,
} from './lease/lease-backend.js';
import './lease/local-lease-backend.js';
import { MEMORY_LEASE_BACKEND_ID } from './lease/memory-lease-backend.js';
import { LOCAL_EVENT_BUS_ID, resolveEventBus } from './event/event-bus.js';
import './event/local-event-bus.js';
import { MEMORY_EVENT_BUS_ID } from './event/memory-event-bus.js';
import { LOCAL_GIT_BACKEND_ID, resolveVcsBackend } from './vcs/vcs-backend.js';
import './vcs/local-git-backend.js';
import { MEMORY_VCS_BACKEND_ID } from './vcs/memory-vcs-backend.js';
import {
  LOOPBACK_TRANSPORT_ID,
  registerProviderTransport,
  resolveProviderTransport,
  type ProviderTransport,
} from './provider-transport.js';
import './provider/loopback-transport.js';
import {
  OTLP_HTTP_TRACE_EXPORTER_ID,
  createMemoryTraceExporter,
  orderedTraceExporters,
  registerTraceExporter,
} from './analysis/trace-exporter.js';
import {
  LOCAL_STORAGE_BACKEND_ID,
  getStorageBackend,
  resolveStorageBackend,
} from './storage/storage-backend.js';
import './storage/local-storage-backend.js';
import { MEMORY_STORAGE_BACKEND_ID } from '@agent/kernel/storage/memory-storage-backend';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('lease-backend saved default', () => {
  it('saved default leads; explicit wins; unregistered falls back', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', `lease-backend=${MEMORY_LEASE_BACKEND_ID}`);
    expect(resolveLeaseBackend().id).toBe(MEMORY_LEASE_BACKEND_ID);
    expect(resolveLeaseBackend(LOCAL_LEASE_BACKEND_ID).id).toBe(LOCAL_LEASE_BACKEND_ID);
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'lease-backend=not-registered');
    expect(resolveLeaseBackend().id).toBe(LOCAL_LEASE_BACKEND_ID);
  });
});

describe('event-bus saved default', () => {
  it('saved default leads; explicit wins; unregistered falls back', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', `event-bus=${MEMORY_EVENT_BUS_ID}`);
    expect(resolveEventBus().id).toBe(MEMORY_EVENT_BUS_ID);
    expect(resolveEventBus(LOCAL_EVENT_BUS_ID).id).toBe(LOCAL_EVENT_BUS_ID);
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'event-bus=not-registered');
    expect(resolveEventBus().id).toBe(LOCAL_EVENT_BUS_ID);
  });
});

describe('vcs-backend saved default', () => {
  it('saved default leads; explicit wins; unregistered falls back', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', `vcs-backend=${MEMORY_VCS_BACKEND_ID}`);
    expect(resolveVcsBackend().id).toBe(MEMORY_VCS_BACKEND_ID);
    expect(resolveVcsBackend(LOCAL_GIT_BACKEND_ID).id).toBe(LOCAL_GIT_BACKEND_ID);
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'vcs-backend=not-registered');
    expect(resolveVcsBackend().id).toBe(LOCAL_GIT_BACKEND_ID);
  });
});

describe('provider-transport saved default', () => {
  it('saved default leads; explicit wins; unregistered falls back', () => {
    const remote: ProviderTransport = {
      id: 'saved-default-test-transport',
      invoke: async () => ({ ok: true, result: undefined }),
    };
    const unregister = registerProviderTransport(remote);
    try {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', `provider-transport=${remote.id}`);
      expect(resolveProviderTransport().id).toBe(remote.id);
      expect(resolveProviderTransport(LOOPBACK_TRANSPORT_ID).id).toBe(LOOPBACK_TRANSPORT_ID);
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'provider-transport=not-registered');
      expect(resolveProviderTransport().id).toBe(LOOPBACK_TRANSPORT_ID);
    } finally {
      unregister();
    }
  });
});

describe('trace-exporter saved default (fan-out)', () => {
  it('moves the saved exporter first and keeps every other exporter', () => {
    const memory = createMemoryTraceExporter('saved-default-test-exporter');
    const unregister = registerTraceExporter(memory);
    try {
      const before = orderedTraceExporters().map((e) => e.id);
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', `trace-exporter=${memory.id}`);
      const after = orderedTraceExporters().map((e) => e.id);
      expect(after[0]).toBe(memory.id);
      expect([...after].sort()).toEqual([...before].sort());
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'trace-exporter=not-registered');
      expect(orderedTraceExporters().map((e) => e.id)).toEqual(before);
    } finally {
      unregister();
    }
    // Sanity: the builtin otlp-http exporter id is still the governed chain head.
    expect(OTLP_HTTP_TRACE_EXPORTER_ID).toBe('otlp-http');
  });
});

describe('storage-backend saved default (kernel resolver injected by core)', () => {
  it('saved default leads; explicit wins; unregistered falls back', () => {
    const id = MEMORY_STORAGE_BACKEND_ID;
    expect(getStorageBackend(id)).toBeDefined();
    expect(resolveStorageBackend().id).toBe(LOCAL_STORAGE_BACKEND_ID);
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', `storage-backend=${id}`);
    expect(resolveStorageBackend().id).toBe(id);
    expect(resolveStorageBackend(LOCAL_STORAGE_BACKEND_ID).id).toBe(LOCAL_STORAGE_BACKEND_ID);
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'storage-backend=not-registered');
    expect(resolveStorageBackend().id).toBe(LOCAL_STORAGE_BACKEND_ID);
  });
});

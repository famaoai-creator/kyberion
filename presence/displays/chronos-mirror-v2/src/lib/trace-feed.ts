import path from "node:path";

import { customerIsConfigured, customerRoot } from "@agent/core/customer-resolver";
import { pathResolver } from "@agent/core/path-resolver";
import { safeExistsSync, safeReadFile, safeReaddir } from "@agent/core/secure-io";

export interface TraceFeedSummary {
  traceId: string;
  tracePath: string;
  persistedAt: string;
  startedAt: string;
  completedAt?: string;
  missionId?: string;
  pipelineId?: string;
  actuator?: string;
  status: "ok" | "error" | "in_progress";
  rootSpanName: string;
  spanCount: number;
  eventCount: number;
  artifactCount: number;
  errorCount: number;
}

export interface TraceFeedRecord extends TraceFeedSummary {
  rootSpan: {
    spanId?: string;
    name: string;
    status: "ok" | "error" | "in_progress";
    startTime: string;
    endTime?: string;
    attributes?: Record<string, string | number | boolean>;
    events: number;
    artifacts: number;
    children: number;
  };
}

export interface TraceEventDetail {
  name: string;
  timestamp: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceArtifactDetail {
  type: "screenshot" | "file" | "document" | "log";
  path: string;
  description?: string;
  timestamp: string;
}

export interface TraceSpanDetail {
  spanId?: string;
  name: string;
  status: "ok" | "error" | "in_progress";
  startTime: string;
  endTime?: string;
  attributes?: Record<string, string | number | boolean>;
  events: TraceEventDetail[];
  artifacts: TraceArtifactDetail[];
  knowledgeRefs: string[];
  error?: string;
  children: TraceSpanDetail[];
}

export interface TraceFeedDetail extends TraceFeedRecord {
  rootSpan: TraceSpanDetail;
}

export interface TraceFeedOptions {
  dir?: string;
  limit?: number;
  status?: "ok" | "error" | "in_progress";
  missionId?: string;
  pipelineId?: string;
  actuator?: string;
  query?: string;
}

interface PersistedTraceShape {
  traceId?: string;
  rootSpan?: unknown;
  metadata?: {
    missionId?: string;
    actuator?: string;
    pipelineId?: string;
    startedAt?: string;
    completedAt?: string;
  };
  _persistedAt?: string;
}

interface TraceNode {
  spanId?: string;
  name?: string;
  status?: "ok" | "error" | "in_progress";
  startTime?: string;
  endTime?: string;
  attributes?: Record<string, string | number | boolean>;
  events?: unknown[];
  artifacts?: unknown[];
  knowledgeRefs?: unknown[];
  children?: TraceNode[];
  error?: string;
}

function asTraceNode(value: unknown): TraceNode | null {
  if (!value || typeof value !== "object") return null;
  return value as TraceNode;
}

export function resolveTraceFeedDirs(): string[] {
  const dirs: string[] = [];
  if (customerIsConfigured()) {
    const customerTraceDir = customerRoot("logs/traces");
    if (customerTraceDir) dirs.push(customerTraceDir);
  }

  dirs.push(pathResolver.sharedLogsTraces());
  return [...new Set(dirs)];
}

function isTraceEventDetail(value: unknown): value is TraceEventDetail {
  return Boolean(value && typeof value === "object" && typeof (value as TraceEventDetail).name === "string");
}

function isTraceArtifactDetail(value: unknown): value is TraceArtifactDetail {
  return Boolean(value && typeof value === "object" && typeof (value as TraceArtifactDetail).type === "string");
}

function countTraceNode(node: TraceNode | null): { spans: number; events: number; artifacts: number; errors: number } {
  if (!node) {
    return { spans: 0, events: 0, artifacts: 0, errors: 0 };
  }

  let spans = 1;
  let events = Array.isArray(node.events) ? node.events.length : 0;
  let artifacts = Array.isArray(node.artifacts) ? node.artifacts.length : 0;
  let errors = node.status === "error" ? 1 : 0;

  for (const child of node.children || []) {
    const childCounts = countTraceNode(asTraceNode(child));
    spans += childCounts.spans;
    events += childCounts.events;
    artifacts += childCounts.artifacts;
    errors += childCounts.errors;
  }

  return { spans, events, artifacts, errors };
}

function normalizeTraceNode(node: TraceNode | null): TraceSpanDetail | null {
  if (!node) return null;

  return {
    spanId: node.spanId,
    name: node.name || "trace",
    status: node.status || "in_progress",
    startTime: node.startTime || new Date().toISOString(),
    endTime: node.endTime,
    attributes: node.attributes,
    events: Array.isArray(node.events) ? node.events.filter(isTraceEventDetail) : [],
    artifacts: Array.isArray(node.artifacts) ? node.artifacts.filter(isTraceArtifactDetail) : [],
    knowledgeRefs: Array.isArray(node.knowledgeRefs)
      ? node.knowledgeRefs.filter((ref): ref is string => typeof ref === "string")
      : [],
    error: node.error,
    children: (node.children || []).map((child) => normalizeTraceNode(asTraceNode(child))).filter(
      (child): child is TraceSpanDetail => Boolean(child),
    ),
  };
}

function matchesTraceQuery(summary: TraceFeedSummary, query?: string): boolean {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    summary.traceId,
    summary.tracePath,
    summary.missionId,
    summary.pipelineId,
    summary.actuator,
    summary.rootSpanName,
    summary.status,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
  return haystack.includes(normalized);
}

function matchesTraceFilters(summary: TraceFeedSummary, options: TraceFeedOptions): boolean {
  if (options.status && summary.status !== options.status) return false;
  if (options.missionId && summary.missionId !== options.missionId) return false;
  if (options.pipelineId && summary.pipelineId !== options.pipelineId) return false;
  if (options.actuator && summary.actuator !== options.actuator) return false;
  return matchesTraceQuery(summary, options.query);
}

export function summarizePersistedTrace(record: PersistedTraceShape, tracePath: string): TraceFeedSummary | null {
  const rootSpan = asTraceNode(record.rootSpan);
  if (!rootSpan || !record.traceId) return null;

  const counts = countTraceNode(rootSpan);
  const startedAt = record.metadata?.startedAt || rootSpan.startTime || record._persistedAt || new Date().toISOString();
  const completedAt = record.metadata?.completedAt || rootSpan.endTime;

  return {
    traceId: record.traceId,
    tracePath,
    persistedAt: record._persistedAt || completedAt || startedAt,
    startedAt,
    completedAt,
    missionId: record.metadata?.missionId,
    pipelineId: record.metadata?.pipelineId,
    actuator: record.metadata?.actuator,
    status: rootSpan.status || "in_progress",
    rootSpanName: rootSpan.name || "trace",
    spanCount: counts.spans,
    eventCount: counts.events,
    artifactCount: counts.artifacts,
    errorCount: counts.errors,
  };
}

export function detailPersistedTrace(record: PersistedTraceShape, tracePath: string): TraceFeedDetail | null {
  const summary = summarizePersistedTrace(record, tracePath);
  const rootSpan = normalizeTraceNode(asTraceNode(record.rootSpan));
  if (!summary || !rootSpan) return null;

  return {
    ...summary,
    rootSpan: {
      ...rootSpan,
      events: rootSpan.events,
      artifacts: rootSpan.artifacts,
      children: rootSpan.children,
    },
  };
}

export function collectTraceFeed(options: TraceFeedOptions = {}): TraceFeedRecord[] {
  const records: TraceFeedRecord[] = [];
  const seen = new Set<string>();

  for (const dir of (options.dir ? [options.dir] : resolveTraceFeedDirs())) {
    if (!safeExistsSync(dir)) continue;

    const files = safeReaddir(dir)
      .filter((entry) => /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(entry))
      .sort()
      .reverse();

    for (const fileName of files) {
      const filePath = path.join(dir, fileName);
      const raw = safeReadFile(filePath, { encoding: "utf8" }) as string;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as PersistedTraceShape;
          const summary = summarizePersistedTrace(parsed, filePath);
          if (!summary) continue;
          if (!matchesTraceFilters(summary, options)) continue;
          const dedupeKey = `${summary.traceId}:${summary.persistedAt}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          records.push({
            ...summary,
            rootSpan: {
              spanId: asTraceNode(parsed.rootSpan)?.spanId,
              name: summary.rootSpanName,
              status: summary.status,
              startTime: summary.startedAt,
              endTime: summary.completedAt,
              attributes: asTraceNode(parsed.rootSpan)?.attributes,
              events: summary.eventCount,
              artifacts: summary.artifactCount,
              children: Math.max(0, summary.spanCount - 1),
            },
          });
        } catch {
          // Skip malformed lines.
        }
      }
    }
  }

  return records
    .sort((a, b) => b.persistedAt.localeCompare(a.persistedAt))
    .slice(0, Math.max(1, options.limit || 24));
}

export function collectTraceDetail(traceId: string, options: TraceFeedOptions = {}): TraceFeedDetail | null {
  if (!traceId) return null;

  for (const dir of (options.dir ? [options.dir] : resolveTraceFeedDirs())) {
    if (!safeExistsSync(dir)) continue;

    const files = safeReaddir(dir)
      .filter((entry) => /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(entry))
      .sort()
      .reverse();

    for (const fileName of files) {
      const filePath = path.join(dir, fileName);
      const raw = safeReadFile(filePath, { encoding: "utf8" }) as string;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as PersistedTraceShape;
          if (parsed.traceId !== traceId) continue;
          const detail = detailPersistedTrace(parsed, filePath);
          if (detail) return detail;
        } catch {
          // Skip malformed lines.
        }
      }
    }
  }

  return null;
}

import { describe, expect, it } from "vitest";

import { buildRuntimeTopology, buildRuntimeTopologyGraph } from "../presence/displays/chronos-mirror-v2/src/lib/runtime-topology";

describe("Chronos runtime topology", () => {
  it("maps owners to managed runtimes and aggregates recent flow", () => {
    const topology = buildRuntimeTopology({
      surfaces: [
        {
          id: "slack-bridge",
          kind: "gateway",
          running: true,
        },
      ],
      runtimes: [
        {
          agentId: "chronos-mirror",
          provider: "gemini",
          modelId: "gemini-2.5-flash",
          status: "ready",
          ownerId: "chronos-ui",
          ownerType: "surface",
          requestedBy: "surface_agent",
          leaseKind: "surface",
          pid: 1234,
        },
        {
          agentId: "presence-surface-agent",
          provider: "gemini",
          modelId: "gemini-2.5-flash",
          status: "ready",
          ownerId: "presence-surface-agent",
          ownerType: "surface",
          requestedBy: "surface_agent",
          leaseKind: "surface",
          pid: 5678,
        },
      ],
      handoffs: [
        {
          ts: "2026-03-24T00:00:10.000Z",
          missionId: "MSN-1",
          sender: "chronos-mirror",
          receiver: "presence-surface-agent",
          promptExcerpt: "handoff prompt",
        },
      ],
      messages: [
        {
          ts: "2026-03-24T00:00:05.000Z",
          missionId: "MSN-1",
          agentId: "chronos-mirror",
          ownerId: "chronos-ui",
          ownerType: "surface",
          type: "agent",
          tone: "response",
          content: "hello",
        },
      ],
    });

    expect(topology.owners).toEqual([
      {
        id: "chronos-ui",
        type: "surface",
        runtimeCount: 1,
        runtimeIds: ["chronos-mirror"],
      },
      {
        id: "presence-surface-agent",
        type: "surface",
        runtimeCount: 1,
        runtimeIds: ["presence-surface-agent"],
      },
    ]);
    expect(topology.runtimes.find((runtime) => runtime.agentId === "chronos-mirror")?.recentActivityCount).toBe(2);
    expect(topology.surfaces).toEqual([
      {
        id: "slack-bridge",
        kind: "gateway",
        running: true,
      },
    ]);
    expect(topology.flows[0]).toMatchObject({
      from: "chronos-mirror",
      to: "presence-surface-agent",
      kind: "a2a",
      count: 1,
    });
  });

  it("builds a graph layout with surface, runtime, and peer nodes", () => {
    const topology = buildRuntimeTopology({
      surfaces: [
        {
          id: "chronos-mirror-v2",
          kind: "ui",
          running: true,
        },
      ],
      runtimes: [
        {
          agentId: "chronos-mirror",
          provider: "gemini",
          status: "ready",
          ownerId: "chronos-ui",
          ownerType: "surface",
        },
      ],
      handoffs: [
        {
          ts: "2026-03-24T00:00:10.000Z",
          missionId: "MSN-1",
          sender: "chronos-mirror",
          receiver: "worker-a",
        },
      ],
      messages: [],
    });

    const graph = buildRuntimeTopologyGraph(topology);
    expect(graph.width).toBeGreaterThan(650);
    expect(graph.nodes.find((node) => node.id === "surface-runtime:chronos-mirror-v2")).toMatchObject({
      kind: "surface",
      column: 0,
    });
    expect(graph.nodes.find((node) => node.id === "chronos-mirror")).toMatchObject({
      kind: "runtime",
      column: 1,
    });
    expect(graph.nodes.find((node) => node.id === "worker-a")).toMatchObject({
      kind: "peer",
      column: 2,
    });
    expect(graph.edges.find((edge) => edge.kind === "a2a")).toMatchObject({
      from: "chronos-mirror",
      to: "worker-a",
      kind: "a2a",
    });
    expect(graph.edges.find((edge) => edge.kind === "surface_link")).toMatchObject({
      from: "surface-runtime:chronos-mirror-v2",
      to: "chronos-mirror",
      kind: "surface_link",
    });
  });
});

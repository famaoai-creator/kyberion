import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver } from '@agent/core/path-resolver';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import { loadAgentProfileDirectory } from '@agent/core/mission-team-index';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

/**
 * Regenerate `agent-profile-index.json` from the canonical agent-profiles
 * directory.
 *
 * The directory is authoritative — `loadAgentProfileIndex` reads it and only
 * falls back to the snapshot — but unlike every other directory/snapshot pair
 * in governance, this one had no generator. So the snapshot was maintained by
 * hand, and it drifted the moment anyone edited a profile: TC-10's `quality`
 * capability went into the directory and left the index behind, which
 * `check_governance_rules` caught only later. A generator removes the class.
 */
const DIRECTORY = pathResolver.knowledge('product/orchestration/agent-profiles');
const SNAPSHOT = pathResolver.knowledge('product/orchestration/agent-profile-index.json');

type AgentProfileRecord = NonNullable<ReturnType<typeof loadAgentProfileDirectory>>[string];

function loadProfiles(): Record<string, AgentProfileRecord> {
  const profiles = loadAgentProfileDirectory();
  if (!profiles) {
    throw new Error(`[sync:agent-profiles] canonical directory not found: ${DIRECTORY}`);
  }
  return profiles;
}

async function render(): Promise<GeneratedFile[]> {
  const profiles = loadProfiles();
  const prettierConfig = (await resolvePrettierConfig(SNAPSHOT)) ?? {};
  const agents: Record<string, AgentProfileRecord> = {};
  for (const [agentId, record] of Object.entries(profiles).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    agents[agentId] = record;
  }
  const payload = {
    $schema: '../schemas/agent-profile-index.schema.json',
    version: '1.0.0',
    agents,
  };
  return [
    {
      path: SNAPSHOT,
      content: await prettierFormat(JSON.stringify(payload, null, 2), {
        ...prettierConfig,
        parser: 'json',
      }),
    },
  ];
}

export const runSyncAgentProfiles = defineGenerator({
  id: 'agent-profiles',
  outputs: [SNAPSHOT],
  normalize: (content) =>
    JSON.stringify(parseSafeJsonObjectInput(content, 'agent-profile generated output')),
  render,
});

if (
  isDirectScript(import.meta.url, 'sync_agent_profiles.ts') ||
  isDirectScript(import.meta.url, 'sync_agent_profiles.js')
)
  void runSyncAgentProfiles();

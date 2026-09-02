import { logger } from '@agent/core/core';
import { safeReadFile, safeMkdir, safeExistsSync } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { retry } from '@agent/core/async-utils';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import * as path from 'node:path';
import { isDirectEntry } from '@agent/core/direct-entry';
import { createHash } from 'node:crypto';
import { runActuatorCli } from '@agent/core/cli-utils';
import { appendJsonLine, nowIso, parseSafeJsonInput } from '@agent/core/foundation';

/**
 * Blockchain-Actuator v1.0.0 [IMMUTABLE ANCHOR]
 * Simulates anchoring mission evidence to a blockchain.
 * In a real-world scenario, this would use Web3.js or Ethers.js to talk to an RPC node.
 */

const MOCK_CHAIN_PATH = pathResolver.active('audit/mock_blockchain.jsonl');
const BLOCKCHAIN_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/blockchain-actuator/manifest.json'
);
const DEFAULT_BLOCKCHAIN_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

interface BlockchainAction {
  action: 'anchor_mission' | 'anchor_trust' | 'verify_anchor';
  params: {
    mission_id?: string;
    agent_id?: string;
    hash?: string;
    score?: number;
    tx_metadata?: any;
  };
}

const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: BLOCKCHAIN_MANIFEST_PATH,
  defaults: DEFAULT_BLOCKCHAIN_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

async function handleAction(input: BlockchainAction) {
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `blockchain:${input.action}`,
    params: input.params || {},
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation blockchain:${input.action} was not admitted.`}`
    );
  }
  const params = preflight.input as BlockchainAction['params'];
  switch (input.action) {
    case 'anchor_mission':
      return await anchorMission(params);
    case 'anchor_trust':
      return await anchorTrust(params);
    case 'verify_anchor':
      return await verifyAnchor(params);
    default:
      throw new Error(`Unsupported blockchain action: ${input.action}`);
  }
}

function readMockChainEntries(): any[] {
  if (!safeExistsSync(MOCK_CHAIN_PATH)) return [];
  try {
    return String(safeReadFile(MOCK_CHAIN_PATH, { encoding: 'utf8' }) || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => parseSafeJsonInput(line, 'mock blockchain entry'));
  } catch {
    return [];
  }
}

async function anchorMission(params: any) {
  const { mission_id, hash } = params;
  if (!mission_id || !hash) throw new Error('mission_id and hash are required for anchoring.');

  logger.info(
    `🔗 [Blockchain] Anchoring mission ${mission_id} (Hash: ${hash.substring(0, 10)}...)`
  );

  const tx = {
    block_number: Math.floor(Date.now() / 10000),
    tx_id: createHash('sha256').update(`tx-${Date.now()}-${mission_id}`).digest('hex'),
    timestamp: nowIso(),
    type: 'MISSION_ANCHOR',
    mission_id,
    data_hash: hash,
    contract_address: '0xKyberionSovereignEvidenceContractV1',
  };

  await retry(async () => {
    _writeToMockChain(tx);
  }, buildRetryOptions());
  return { status: 'success', simulated: true, tx_id: tx.tx_id, block: tx.block_number };
}

async function anchorTrust(params: any) {
  const { agent_id, score } = params;
  if (!agent_id || score === undefined) throw new Error('agent_id and score are required.');

  logger.info(`🔗 [Blockchain] Anchoring trust score for ${agent_id} (Score: ${score})`);

  const tx = {
    block_number: Math.floor(Date.now() / 10000),
    tx_id: createHash('sha256').update(`tx-trust-${Date.now()}-${agent_id}`).digest('hex'),
    timestamp: nowIso(),
    type: 'TRUST_SCORE_ANCHOR',
    agent_id,
    new_score: score,
    contract_address: '0xKyberionTrustGovernanceContractV1',
  };

  await retry(async () => {
    _writeToMockChain(tx);
  }, buildRetryOptions());
  return { status: 'success', simulated: true, tx_id: tx.tx_id, block: tx.block_number };
}

async function verifyAnchor(params: any) {
  const { mission_id, agent_id, hash } = params;
  if (!mission_id && !agent_id) throw new Error('mission_id or agent_id is required.');

  const entries = readMockChainEntries();
  const matching = entries.filter((entry) => {
    if (mission_id) {
      return (
        entry.type === 'MISSION_ANCHOR' &&
        entry.mission_id === mission_id &&
        (hash ? entry.data_hash === hash : true)
      );
    }
    return entry.type === 'TRUST_SCORE_ANCHOR' && entry.agent_id === agent_id;
  });

  return {
    status: matching.length > 0 ? 'verified' : 'not_found',
    simulated: true,
    verified: matching.length > 0,
    matches: matching.length,
  };
}

function _writeToMockChain(tx: any) {
  const dir = path.dirname(MOCK_CHAIN_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  appendJsonLine(MOCK_CHAIN_PATH, tx);
}

const main = async () => {
  await runActuatorCli({
    name: 'blockchain-actuator',
    args: process.argv,
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/blockchain-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'blockchain-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as unknown as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

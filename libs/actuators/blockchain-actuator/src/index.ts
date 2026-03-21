import { logger, safeReadFile, safeAppendFileSync, safeMkdir, safeExistsSync, createStandardYargs, pathResolver } from '@agent/core';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Blockchain-Actuator v1.0.0 [IMMUTABLE ANCHOR]
 * Simulates anchoring mission evidence to a blockchain.
 * In a real-world scenario, this would use Web3.js or Ethers.js to talk to an RPC node.
 */

const MOCK_CHAIN_PATH = pathResolver.active('audit/mock_blockchain.jsonl');

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

async function handleAction(input: BlockchainAction) {
  switch (input.action) {
    case 'anchor_mission': return await anchorMission(input.params);
    case 'anchor_trust': return await anchorTrust(input.params);
    default: throw new Error(`Unsupported blockchain action: ${input.action}`);
  }
}

async function anchorMission(params: any) {
  const { mission_id, hash } = params;
  if (!mission_id || !hash) throw new Error('mission_id and hash are required for anchoring.');

  logger.info(`🔗 [Blockchain] Anchoring mission ${mission_id} (Hash: ${hash.substring(0, 10)}...)`);
  
  const tx = {
    block_number: Math.floor(Date.now() / 10000),
    tx_id: createHash('sha256').update(`tx-${Date.now()}-${mission_id}`).digest('hex'),
    timestamp: new Date().toISOString(),
    type: 'MISSION_ANCHOR',
    mission_id,
    data_hash: hash,
    contract_address: '0xKyberionSovereignEvidenceContractV1'
  };

  _writeToMockChain(tx);
  return { status: 'success', tx_id: tx.tx_id, block: tx.block_number };
}

async function anchorTrust(params: any) {
  const { agent_id, score } = params;
  if (!agent_id || score === undefined) throw new Error('agent_id and score are required.');

  logger.info(`🔗 [Blockchain] Anchoring trust score for ${agent_id} (Score: ${score})`);

  const tx = {
    block_number: Math.floor(Date.now() / 10000),
    tx_id: createHash('sha256').update(`tx-trust-${Date.now()}-${agent_id}`).digest('hex'),
    timestamp: new Date().toISOString(),
    type: 'TRUST_SCORE_ANCHOR',
    agent_id,
    new_score: score,
    contract_address: '0xKyberionTrustGovernanceContractV1'
  };

  _writeToMockChain(tx);
  return { status: 'success', tx_id: tx.tx_id, block: tx.block_number };
}

function _writeToMockChain(tx: any) {
  const dir = path.dirname(MOCK_CHAIN_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeAppendFileSync(MOCK_CHAIN_PATH, JSON.stringify(tx) + '\n');
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
    
  const inputContent = safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };

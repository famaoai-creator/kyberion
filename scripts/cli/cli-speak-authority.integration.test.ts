import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { seedFirstJobTestRoot } from '../fixtures/first-job-approval-fixture.js';

const CHILD = `
const {runAudibleSpeak} = await import(process.argv[1]);
const {runExternalOperation} = await import('@agent/core/governance/external-operation');
const {listApprovalRequests, decideApprovalRequest, computeApprovalPresentedDigest} = await import('@agent/core/governance/approval-store');
const operationId = process.argv[2];
let effects = 0;
const id = '12345678-1234-4321-8123-123456789012';
const play = (text) => runAudibleSpeak(id, {text}, () => runExternalOperation({
  operationId, requiresApproval: true, delegable: true,
  effect: operationId === 'voice:speak'
    ? { params: {platform: 'darwin'}, text }
    : { params: {platform: 'darwin', content_hash: text === 'fixture text' ? 'a'.repeat(64) : 'b'.repeat(64), format: '.wav'} },
}, async () => { effects++; return 'played'; }, () => 'succeeded'));
const blocked = async (text) => {
  try { await play(text); throw new Error('An effect should have been blocked'); }
  catch (error) { return error.message; }
};
const requests = () => listApprovalRequests({storageChannels: ['external-operation']});
const pending = await blocked('fixture text');
const queued = requests();
if (queued.length !== 1) throw new Error('Expected one approval. ' + pending);
const same = await blocked('fixture text');
const sameCount = requests().length;
if (effects !== 0) throw new Error('Audio ran before approval');
const [request] = queued;
decideApprovalRequest('mission_controller', {
  channel: request.channel, storageChannel: request.storageChannel, requestId: request.id,
  decision: 'approved', decidedBy: 'user:owner', decidedByType: 'human',
  authenticated: true, authMethod: 'terminal_attested', deciderIdentitySource: 'server_resolved',
  presentedDigest: computeApprovalPresentedDigest(request),
  payloadHash: request.accountability.payloadHash, effectBinding: request.accountability.effectBinding,
});
const resumed = await play('fixture text');
const repeated = await blocked('fixture text');
const changed = await blocked('different text');
process.stdout.write('SPEAK_FIXTURE:' + JSON.stringify({
  id, pending, same, sameCount, requestId: request.id, resumed, repeated, changed, effects
}) + '\\n');
`;

let root = '';
beforeEach(() => {
  root = pathResolver.sharedTmp(`cli-speak-authority-${randomUUID()}`);
  seedFirstJobTestRoot(pathResolver.rootDir(), root);
  const manifest = 'libs/actuators/voice-actuator/manifest.json';
  safeWriteFile(path.join(root, manifest), safeReadFile(pathResolver.rootResolve(manifest)));
}, 60_000);
afterEach(() => {
  if (root) safeRmSync(root, { recursive: true, force: true });
});

it.each(['voice:speak', 'voice:playback'])(
  'queues and consumes exact headless approval for %s',
  (operationId) => {
    const result = safeExecResult(
      process.execPath,
      [
        '--import',
        pathResolver.rootResolve('scripts/ts-loader.mjs'),
        '--input-type=module',
        '-e',
        CHILD,
        new URL('./cli-speak-authority.ts', import.meta.url).href,
        operationId,
      ],
      {
        cwd: pathResolver.rootDir(),
        env: {
          KYBERION_ROOT: root,
          KYBERION_BASE_ROLE: '',
          SYSTEM_ROLE: '',
          MISSION_ROLE: '',
          MISSION_ID: '',
          KYBERION_TENANT: '',
          KYBERION_STANCE: '',
          KYBERION_NHI_ACTOR: '',
          KYBERION_TIER: 'public',
        },
        timeoutMs: 60_000,
      }
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const line = result.stdout.split('\n').find((value) => value.startsWith('SPEAK_FIXTURE:'));
    expect(line, result.stdout).toBeDefined();
    const response = JSON.parse(line!.slice('SPEAK_FIXTURE:'.length));
    expect(response.pending).toContain(`approval: ${response.requestId}`);
    expect(response.pending).toContain(`--invocation-id ${response.id}`);
    expect(response.same).toContain(`approval: ${response.requestId}`);
    expect(response.sameCount).toBe(1);
    expect(response.resumed).toBe('played');
    expect(response.repeated).toContain('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(response.changed).toContain('EXTERNAL_APPROVAL_REQUIRED');
    expect(response.changed).not.toContain(`approval: ${response.requestId}`);
    expect(response.effects).toBe(1);
  },
  60_000
);

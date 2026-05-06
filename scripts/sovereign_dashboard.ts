import * as path from 'node:path';
import {
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  listSurfaceOutboxMessages,
  logger,
  pathResolver,
  safeExistsSync,
  safeReaddir,
} from '@agent/core';
import chalk from 'chalk';
import { readJsonFile, readTextFile } from './refactor/cli-input.js';

/**
 * Kyberion Sovereign Dashboard v1.0
 * Pure ANSI-based TUI for real-time ecosystem observability.
 */

const ROOT_DIR = pathResolver.rootDir();

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function drawHeader() {
  console.log(chalk.bold.cyan(' 🌌 KYBERION SOVEREIGN ECOSYSTEM | CEO DASHBOARD v1.0 '));
  console.log(chalk.dim(' --------------------------------------------------- '));
  console.log(` Status: ${chalk.green('OPERATIONAL')} | User: ${chalk.bold('famao')} | Time: ${new Date().toLocaleTimeString()}\n`);
}

function readJsonIfExists<T>(logicalPath: string): T | null {
  if (!safeExistsSync(logicalPath)) return null;
  try {
    return readJsonFile<T>(logicalPath);
  } catch {
    return null;
  }
}

function listJsonFiles(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(dir, entry));
}

function drawOnboardingHome() {
  console.log(chalk.bold.green(' 🏠 ONBOARDING HOME'));

  const onboardingStatePath = pathResolver.knowledge('personal/onboarding/onboarding-state.json');
  const onboardingState = readJsonIfExists<{
    status?: string;
    current_phase?: string;
    completed_phases?: string[];
    identity?: { name?: string; agent_id?: string; language?: string; interaction_style?: string; primary_domain?: string };
    services?: { candidates?: Array<{ service_id: string; status?: string; connection_kind?: string }> };
    tenants?: { entries?: Array<{ tenant_slug: string; display_name?: string; assigned_role?: string }> };
    tutorial?: { mode?: string; summary?: string };
  }>(onboardingStatePath);

  const connectionDir = pathResolver.knowledge('personal/connections');
  const tenantDir = pathResolver.knowledge('personal/tenants');
  const connectionFiles = listJsonFiles(connectionDir);
  const tenantFiles = listJsonFiles(tenantDir);
  const readiness = readJsonIfExists<{
    required_services?: Record<string, { required_keys_any?: string[] }>;
  }>(pathResolver.knowledge('public/governance/service-connection-readiness.json'));

  const serviceMap = new Map<string, Record<string, unknown>>();
  for (const file of connectionFiles) {
    const serviceId = path.basename(file, '.json');
    const payload = readJsonIfExists<Record<string, unknown>>(file);
    if (payload) serviceMap.set(serviceId, payload);
  }

  const requiredServices = Object.entries(readiness?.required_services || {});
  const readyServices: string[] = [];
  const blockedServices: string[] = [];
  for (const [serviceId, policy] of requiredServices) {
    const record = serviceMap.get(serviceId);
    const requiredKeys = policy.required_keys_any || [];
    const hasRequiredKey = requiredKeys.length === 0
      ? Boolean(record)
      : requiredKeys.some((key) => Boolean(record && Object.prototype.hasOwnProperty.call(record, key)));
    if (hasRequiredKey) readyServices.push(serviceId);
    else blockedServices.push(serviceId);
  }

  const onboardingComplete = onboardingState?.status === 'complete';
  const phaseLabel = onboardingState?.current_phase || 'identity';
  const identity = onboardingState?.identity;
  const tenantEntries = onboardingState?.tenants?.entries || [];
  const tutorial = onboardingState?.tutorial;

  console.log(`  ${chalk.gray('•')} State: ${onboardingComplete ? chalk.green('complete') : chalk.yellow('draft')} ${chalk.dim(`phase=${phaseLabel}`)}`);
  console.log(`  ${chalk.gray('•')} Identity: ${chalk.cyan(identity?.name || 'Sovereign')} ${chalk.dim(`/${identity?.agent_id || 'KYBERION-PRIME'}`)}`);
  console.log(`  ${chalk.gray('•')} Services: ${readyServices.length > 0 ? chalk.green(`${readyServices.length} ready`) : chalk.dim('0 ready')} / ${blockedServices.length > 0 ? chalk.yellow(`${blockedServices.length} blocked`) : chalk.dim('0 blocked')}`);
  console.log(`  ${chalk.gray('•')} Tenants: ${tenantFiles.length > 0 ? chalk.green(tenantFiles.length) : chalk.dim(0)} registered`);
  console.log(`  ${chalk.gray('•')} Tutorial: ${tutorial?.mode ? chalk.cyan(tutorial.mode) : chalk.dim('not started')}`);

  const recommendedNextAction = !onboardingComplete
    ? 'Run `pnpm onboard` and resume the current phase.'
    : blockedServices.length > 0
      ? `Review ${blockedServices.join(', ')} connection drafts.`
      : tenantEntries.length === 0
        ? 'Register the first tenant and then choose a starter mission.'
        : 'Pick a starter mission from the current tenant context.';

  console.log(`  ${chalk.gray('•')} Next: ${chalk.white(recommendedNextAction)}`);

  if (connectionFiles.length > 0) {
    console.log(chalk.dim('  Connections:'));
    for (const file of connectionFiles.slice(0, 4)) {
      const serviceId = path.basename(file, '.json');
      const status = serviceMap.has(serviceId) ? chalk.green('captured') : chalk.yellow('pending');
      console.log(`    ${chalk.gray('•')} ${serviceId.padEnd(16)} ${status}`);
    }
  } else {
    console.log(chalk.dim('  Connections: none captured yet'));
  }
  console.log('');
}

function drawMissions() {
  const missionDirs = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions')
  ];

  console.log(chalk.bold.yellow(' 📋 ACTIVE MISSIONS'));
  let count = 0;
  for (const dir of missionDirs) {
    if (!safeExistsSync(dir)) continue;
    const items = safeReaddir(dir);
    for (const item of items) {
      const statePath = path.join(dir, item, 'mission-state.json');
      if (safeExistsSync(statePath)) {
        const state = readJsonFile<any>(statePath);
        if (state.status === 'active') {
          const color = state.tier === 'personal' ? chalk.magenta : chalk.blue;
          const missionPath = path.join(dir, item);
          const planReady = safeExistsSync(path.join(missionPath, 'PLAN.md'));
          const nextTasksPath = path.join(missionPath, 'NEXT_TASKS.json');
          const nextTaskCount = safeExistsSync(nextTasksPath)
            ? (readJsonFile<any[]>(nextTasksPath)?.length || 0)
            : 0;
          const planning = planReady ? chalk.green('PLAN READY') : chalk.yellow('PLANNING');
          console.log(`  ${chalk.gray('•')} ${color(state.mission_id.padEnd(25))} [${chalk.green('ACTIVE')}] ${chalk.dim(state.mission_type || 'development')} ${chalk.gray(`next=${nextTaskCount}`)} ${planning}`);
          count++;
        }
      }
    }
  }
  if (count === 0) console.log(chalk.dim('  (No active missions)'));
  console.log('');
}

function drawMissionOrchestration() {
  const eventsPath = pathResolver.shared('observability/mission-control/orchestration-events.jsonl');
  const slackMissionsPath = pathResolver.shared('observability/channels/slack/missions.jsonl');

  console.log(chalk.bold.cyan(' 🧭 MISSION ORCHESTRATION'));

  const events: Array<{ ts: string; decision: string; mission?: string; why?: string }> = [];
  for (const file of [eventsPath, slackMissionsPath]) {
    if (!safeExistsSync(file)) continue;
    const raw = readTextFile(file);
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        events.push({
          ts: event.ts || new Date().toISOString(),
          decision: event.decision || event.event_type || 'event',
          mission: event.mission_id || event.resource_id,
          why: event.why,
        });
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  if (events.length === 0) {
    console.log(chalk.dim('  (No orchestration events yet)'));
    console.log('');
    return;
  }

  const latest = events.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
  for (const event of latest) {
    const ts = event.ts.replace('T', ' ').slice(5, 16);
    console.log(`  ${chalk.gray('•')} ${chalk.dim(ts)} ${chalk.white(event.decision.padEnd(30))} ${chalk.cyan((event.mission || 'system').slice(0, 32))}`);
    if (event.why) {
      console.log(`    ${chalk.dim(event.why.slice(0, 96))}`);
    }
  }
  console.log('');
}

function drawOwnerSummaries() {
  const slackMissionsPath = pathResolver.shared('observability/channels/slack/missions.jsonl');
  console.log(chalk.bold.yellow(' 👑 OWNER SUMMARIES'));

  if (!safeExistsSync(slackMissionsPath)) {
    console.log(chalk.dim('  (No owner summaries yet)'));
    console.log('');
    return;
  }

  const summaries = readTextFile(slackMissionsPath)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => Boolean(event))
    .filter((event) => (event.decision || event.event_type) === 'mission_owner_notified')
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, 4);

  if (summaries.length === 0) {
    console.log(chalk.dim('  (No owner summaries yet)'));
    console.log('');
    return;
  }

  for (const summary of summaries) {
    console.log(`  ${chalk.gray('•')} ${chalk.cyan(String(summary.mission_id || 'unknown').slice(0, 32))} ${chalk.dim(`accepted=${summary.accepted_count || 0} reviewed=${summary.reviewed_count || 0} completed=${summary.completed_count || 0} requested=${summary.requested_count || 0}`)}`);
  }
  console.log('');
}

function drawRuntimeLeaseDoctor() {
  console.log(chalk.bold.red(' 🩺 RUNTIME LEASE DOCTOR'));

  const missions = new Set<string>();
  const missionDirs = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
  ];
  for (const dir of missionDirs) {
    if (!safeExistsSync(dir)) continue;
    for (const item of safeReaddir(dir)) {
      const statePath = path.join(dir, item, 'mission-state.json');
      if (!safeExistsSync(statePath)) continue;
      const state = readJsonFile<any>(statePath);
      if (state.status === 'active' && typeof state.mission_id === 'string') {
        missions.add(state.mission_id);
      }
    }
  }

  const runtimeSnapshots = new Map(
    listAgentRuntimeSnapshots().map((snapshot) => [snapshot.agent.agentId, snapshot]),
  );
  const findings = listAgentRuntimeLeaseSummaries().flatMap((lease) => {
    const runtime = runtimeSnapshots.get(lease.agent_id);
    if (!runtime) return [];
    if (lease.owner_type === 'mission' && !missions.has(lease.owner_id)) {
      return [{
        severity: 'critical',
        agentId: lease.agent_id,
        reason: 'orphaned mission lease',
      }];
    }
    if (runtime.agent.status === 'error') {
      return [{
        severity: 'warning',
        agentId: lease.agent_id,
        reason: 'runtime in error state',
      }];
    }
    const executionMode = typeof lease.metadata?.execution_mode === 'string' ? lease.metadata.execution_mode : undefined;
    const channel = typeof lease.metadata?.channel === 'string' ? lease.metadata.channel : undefined;
    if (executionMode === 'conversation' && channel === 'slack' && runtime.runtime?.idleForMs && runtime.runtime.idleForMs > 5 * 60 * 1000) {
      return [{
        severity: 'warning',
        agentId: lease.agent_id,
        reason: 'stale slack conversation lease',
      }];
    }
    return [];
  }).slice(0, 6);

  if (findings.length === 0) {
    console.log(chalk.dim('  (No runtime doctor findings)'));
    console.log('');
    return;
  }

  for (const finding of findings) {
    const severity = finding.severity === 'critical' ? chalk.red('CRITICAL') : chalk.yellow('WARNING');
    console.log(`  ${chalk.gray('•')} ${finding.agentId.padEnd(24)} [${severity}] ${chalk.dim(finding.reason)}`);
  }
  console.log('');
}

function drawSlackOutbox() {
  console.log(chalk.bold.green(' 📬 SURFACE OUTBOX'));
  const slackMessages = listSurfaceOutboxMessages('slack');
  const chronosMessages = listSurfaceOutboxMessages('chronos');
  console.log(`  Slack pending:   ${slackMessages.length > 0 ? chalk.bold.yellow(slackMessages.length) : chalk.dim(0)}`);
  console.log(`  Chronos pending: ${chronosMessages.length > 0 ? chalk.bold.yellow(chronosMessages.length) : chalk.dim(0)}`);
  for (const message of slackMessages.slice(0, 4)) {
    console.log(`  ${chalk.gray('•')} ${chalk.cyan(`slack/${message.source}`.padEnd(14))} ${chalk.dim(message.channel)} ${chalk.white(message.text.slice(0, 64))}`);
  }
  for (const message of chronosMessages.slice(0, 2)) {
    console.log(`  ${chalk.gray('•')} ${chalk.cyan(`chronos/${message.source}`.padEnd(14))} ${chalk.dim(message.channel)} ${chalk.white(message.text.slice(0, 64))}`);
  }
  console.log('');
}

function drawA2ATraffic() {
  const inbox = pathResolver.rootResolve('active/shared/runtime/a2a/inbox');
  const outbox = pathResolver.rootResolve('active/shared/runtime/a2a/outbox');
  
  console.log(chalk.bold.magenta(' 📡 A2A TRAFFIC'));
  
  const inCount = safeExistsSync(inbox) ? safeReaddir(inbox).length : 0;
  const outCount = safeExistsSync(outbox) ? safeReaddir(outbox).length : 0;

  console.log(`  Inbox:  ${inCount > 0 ? chalk.bold.green(inCount) : chalk.dim(0)} pending`);
  console.log(`  Outbox: ${outCount > 0 ? chalk.bold.yellow(outCount) : chalk.dim(0)} sending\n`);
}

function drawRuntimeSurfaces() {
  const statePath = pathResolver.shared('runtime/surfaces/state.json');
  const manifestPath = pathResolver.knowledge('public/governance/active-surfaces.json');

  console.log(chalk.bold.blue(' 🛰️ RUNTIME SURFACES'));

  if (!safeExistsSync(manifestPath)) {
    console.log(chalk.dim('  (Surface manifest not found)'));
    console.log('');
    return;
  }

  const manifest = readJsonFile<{
    surfaces: Array<{ id: string; kind: string; startupMode?: string }>;
  }>(manifestPath);
  const state = safeExistsSync(statePath)
    ? readJsonFile<{ surfaces: Record<string, { pid: number }> }>(statePath)
    : { surfaces: {} };

  for (const surface of manifest.surfaces) {
    const record = state.surfaces?.[surface.id];
    const status = record?.pid ? chalk.green('RUNNING') : chalk.dim('STOPPED');
    const pid = record?.pid ? chalk.gray(` pid=${record.pid}`) : '';
    console.log(`  ${chalk.gray('•')} ${surface.id.padEnd(20)} [${status}] ${chalk.dim(surface.kind)}${pid}`);
  }
  console.log('');
}

function drawTrustBoard() {
  const ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
  console.log(chalk.bold.green(' 🤝 AGENT TRUST BOARD'));
  if (safeExistsSync(ledgerPath)) {
    const raw = readJsonFile<any>(ledgerPath);
    const ledger = raw?.agents ?? raw ?? {};
    Object.keys(ledger).forEach(a => {
      const score = ledger[a].current_score / 100;
      const bar = '█'.repeat(Math.floor(score)) + '░'.repeat(10 - Math.floor(score));
      console.log(`  ${a.padEnd(15)} [${chalk.cyan(bar)}] ${score.toFixed(1)}`);
    });
  } else {
    console.log(chalk.dim('  (Trust ledger not found)'));
  }
  console.log('');
}

function render() {
  clearScreen();
  drawHeader();
  drawOnboardingHome();
  drawMissions();
  drawMissionOrchestration();
  drawOwnerSummaries();
  drawRuntimeLeaseDoctor();
  drawRuntimeSurfaces();
  drawSlackOutbox();
  drawA2ATraffic();
  drawTrustBoard();
  console.log(chalk.dim(' Press Ctrl+C to exit. Refreshing every 5s...'));
}

if (process.argv.includes('--once')) {
  render();
} else {
  render();
  setInterval(render, 5000);
}

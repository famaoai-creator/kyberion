/**
 * Meeting Orchestrator (CLI)
 *
 * Drives the AI-runs-meetings flow end-to-end:
 *   facilitate → join → listen → extract action items → run self-execution
 *   sweep → schedule tracking → leave.
 *
 * Each stage is a thin wrapper around an existing pipeline so the
 * orchestrator itself stays declarative — the heavy lifting lives in
 * `meeting-facilitation-workflow.json`,
 * `action-item-execute-self.json`, and `action-item-tracking.json`.
 *
 * Usage:
 *   node dist/scripts/meeting_orchestrator.js \
 *     --mission MSN-MEETING-2026-Q2 \
 *     --meeting-url "https://example.zoom.us/j/9999999999" \
 *     --platform zoom \
 *     --persona "Operator" \
 *     --listen-sec 60 \
 *     --skip-tracking
 *
 * Stages can be skipped with --skip-{stage}; useful when re-running
 * after a partial failure.
 */

import * as path from 'node:path';
import {
  buildMeetingOperationsBrief,
  getMeetingBriefQuestions,
  logger,
  pathResolver,
  safeWriteFile,
  safeMkdir,
  safeExec,
  listOperatorSelfPending,
  listOthersPending,
  listActionItems,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { readTextFile } from './refactor/cli-input.js';

interface OrchestratorOptions {
  mission: string;
  meetingUrl?: string;
  platform: 'zoom' | 'teams' | 'meet' | 'auto';
  persona: string;
  profileId: string;
  operationsProfilePath: string;
  meetingTitle: string;
  purpose: string;
  agentId: string;
  agenda: string[];
  attendees: Array<{ name: string; person_slug?: string; channel_handle?: string }>;
  listenSec: number;
  language: string;
  skipFacilitate: boolean;
  skipSelf: boolean;
  skipTracking: boolean;
}

function runPipeline(name: string, context: Record<string, unknown>): void {
  const ctx = JSON.stringify({ mission_id: context.mission_id, ...context });
  logger.info(`▶ pipelines/${name}.json`);
  const out = safeExec(
    'node',
    [
      pathResolver.rootResolve('dist/scripts/run_pipeline.js'),
      '--input',
      `pipelines/${name}.json`,
      '--context',
      ctx,
    ],
    { cwd: pathResolver.rootDir() }
  );
  if (out.trim()) logger.info(out.trim());
}

function summarize(missionId: string): void {
  const all = listActionItems(missionId);
  const selfPending = listOperatorSelfPending(missionId);
  const othersPending = listOthersPending(missionId);
  logger.info('');
  logger.info(`📋 Mission ${missionId} action-item summary:`);
  logger.info(`   total recorded: ${all.length}`);
  logger.info(`   operator_self pending: ${selfPending.length}`);
  logger.info(`   team_member pending: ${othersPending.length}`);
  for (const item of all) {
    const tag =
      item.assignee.kind === 'operator_self'
        ? '🟢'
        : item.assignee.kind === 'team_member'
          ? '🟡'
          : '⚪️';
    logger.info(
      `   ${tag} [${item.status}] ${item.item_id}: ${item.title} (assignee=${item.assignee.label})`
    );
  }
}

function loadOperationsProfile(profilePath: string): any {
  return JSON.parse(readTextFile(pathResolver.rootResolve(profilePath)));
}

function writeMeetingBrief(missionId: string, brief: unknown): string {
  const dir = pathResolver.rootResolve('active/shared/runtime/meeting/briefs');
  safeMkdir(dir, { recursive: true });
  const outputPath = path.join(dir, `${missionId}.json`);
  safeWriteFile(outputPath, JSON.stringify(brief, null, 2));
  return outputPath;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('mission', { type: 'string', demandOption: true })
    .option('meeting-url', { type: 'string' })
    .option('platform', { type: 'string', default: 'auto' })
    .option('persona', { type: 'string', default: 'Operator' })
    .option('profile-id', { type: 'string', default: 'operator-default-v1' })
    .option('operations-profile', {
      type: 'string',
      default: 'knowledge/public/schemas/meeting-operations-profile.example.json',
    })
    .option('meeting-title', { type: 'string', default: 'Live meeting' })
    .option('purpose', {
      type: 'string',
      default: 'default',
    })
    .option('agent-id', { type: 'string', default: 'meeting-proxy' })
    .option('agenda', { type: 'string', default: '' })
    .option('attendees', { type: 'string', default: '' })
    .option('listen-sec', { type: 'number', default: 60 })
    .option('language', { type: 'string', default: 'ja' })
    .option('skip-facilitate', { type: 'boolean', default: false })
    .option('skip-self', { type: 'boolean', default: false })
    .option('skip-tracking', { type: 'boolean', default: false })
    .parseSync();

  const agenda = (argv.agenda as string)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  let attendees: OrchestratorOptions['attendees'] = [];
  if (argv.attendees) {
    try {
      const a = (argv.attendees as string).startsWith('@')
        ? JSON.parse(readTextFile(pathResolver.rootResolve((argv.attendees as string).slice(1))))
        : JSON.parse(argv.attendees as string);
      attendees = Array.isArray(a) ? a : [];
    } catch (err: any) {
      logger.warn(
        `[orchestrator] failed to parse --attendees: ${err?.message ?? err}; proceeding with []`
      );
    }
  }

  const options: OrchestratorOptions = {
    mission: String(argv.mission),
    ...(argv['meeting-url'] ? { meetingUrl: String(argv['meeting-url']) } : {}),
    platform: ((argv.platform as any) ?? 'auto') as OrchestratorOptions['platform'],
    persona: String(argv.persona),
    profileId: String(argv['profile-id']),
    operationsProfilePath: String(argv['operations-profile']),
    meetingTitle: String(argv['meeting-title']),
    purpose: String(argv.purpose),
    agentId: String(argv['agent-id']),
    agenda,
    attendees,
    listenSec: Number(argv['listen-sec']),
    language: String(argv.language),
    skipFacilitate: Boolean(argv['skip-facilitate']),
    skipSelf: Boolean(argv['skip-self']),
    skipTracking: Boolean(argv['skip-tracking']),
  };

  process.env.MISSION_ID = options.mission;

  logger.info(
    `🎙️ meeting_orchestrator start (mission=${options.mission}, platform=${options.platform})`
  );

  const operationsProfile = loadOperationsProfile(options.operationsProfilePath);
  const meetingBrief = buildMeetingOperationsBrief(
    {
      meeting_title: options.meetingTitle,
      meeting_url: options.meetingUrl || '',
      platform: options.platform,
      purpose: options.purpose,
      agenda: options.agenda.length ? options.agenda : ['Status', 'Action items'],
      participants: options.attendees,
      desired_outcomes: [
        'Clarify the meeting goal',
        'Capture action items with owners and deadlines',
      ],
      own_tasks: ['Facilitate the meeting', 'Track follow-ups'],
      tracking_expectations: ['Track team_member items until closed'],
      notes: `persona=${options.persona}`,
    },
    operationsProfile
  );
  const briefQuestions = getMeetingBriefQuestions(operationsProfile, options.purpose);
  const briefPath = writeMeetingBrief(options.mission, meetingBrief);

  logger.info(`🧭 Meeting brief loaded from ${options.operationsProfilePath}`);
  logger.info(`   purpose: ${meetingBrief.purpose}`);
  logger.info(`   primary_role: ${meetingBrief.primary_role}`);
  logger.info(`   follow_up_channel: ${meetingBrief.follow_up_channel}`);
  logger.info(`   brief_path: ${briefPath}`);
  if (briefQuestions.length > 0) {
    logger.info(`   preflight questions:`);
    for (const q of briefQuestions.slice(0, 3)) {
      logger.info(`   - ${q}`);
    }
  }

  if (!options.skipFacilitate) {
    if (!options.meetingUrl) {
      logger.warn(
        '⏭ skipping facilitation stage because --meeting-url was not provided; provide a Teams/Zoom/Meet URL to join live.'
      );
    } else {
      const meetingBriefSummary = [
        `${meetingBrief.purpose} / ${meetingBrief.primary_role}`,
        ...meetingBrief.desired_outcomes.slice(0, 3),
      ].join(' | ');
      runPipeline('meeting-facilitation-workflow', {
        mission_id: options.mission,
        persona_name: options.persona,
        profile_id: options.profileId,
        agent_id: options.agentId,
        meeting_url: options.meetingUrl ?? '',
        platform: options.platform,
        agenda: options.agenda.length ? options.agenda : ['Status check', 'Action items'],
        attendees: options.attendees,
        listen_duration_sec: options.listenSec,
        language: options.language,
        operator_label: options.persona,
        meeting_brief: meetingBrief,
        meeting_brief_summary: meetingBriefSummary,
        meeting_brief_purpose: meetingBrief.purpose,
        meeting_brief_primary_role: meetingBrief.primary_role,
        meeting_brief_follow_up_channel: meetingBrief.follow_up_channel,
        meeting_brief_path: briefPath,
      });
    }
  } else {
    logger.info('⏭ skipping facilitation stage (--skip-facilitate).');
  }

  if (!options.skipSelf) {
    runPipeline('action-item-execute-self', {
      mission_id: options.mission,
      language: options.language,
    });
  } else {
    logger.info('⏭ skipping self-execution sweep (--skip-self).');
  }

  if (!options.skipTracking) {
    runPipeline('action-item-tracking', {
      mission_id: options.mission,
      language: options.language,
      tone: 'friendly',
      max_items_per_run: 20,
    });
  } else {
    logger.info('⏭ skipping tracking sweep (--skip-tracking).');
  }

  summarize(options.mission);
}

const isDirect = process.argv[1] && /meeting_orchestrator\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}

export { main as runMeetingOrchestrator };

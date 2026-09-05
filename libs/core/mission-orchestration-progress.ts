import * as path from 'node:path';
import type { PlanningPacket } from './channel-surface.js';
import {
  emitMissionTaskEvent,
  missionTaskEventsPath,
  parseMissionTaskEventIdentity,
  type MissionTaskEventIdentity,
} from './mission-task-events.js';
import { ledger } from './ledger.js';
import { findMissionPath, missionDir } from './path-resolver.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { readTextFile } from './foundation/text.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import {
  provisionMissionEntry,
  writeProvisionedJson,
  writeProvisionedText,
} from './mission-orchestration-journal.js';
import { validatePlanningPacket } from './planning-packet-contract.js';
import { readProcessTemplateSeededTasks } from './mission-planning-packet.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import type { PlannedNextTask } from './mission-orchestration-worker-contracts.js';

type GateSummary = { lines: string[]; reworkCount: number };

export interface MissionProgressControllerDependencies {
  validatePlannedNextTasks(rawTasks: unknown, missionId: string): PlannedNextTask[];
  summarizeMissionGateState(missionId: string): GateSummary;
}

export interface MissionProgressController {
  syncPlanningArtifacts(missionId: string): void;
  persistPlanningPacket(missionId: string, packet: PlanningPacket): void;
  loadPlannedNextTasks(missionId: string): PlannedNextTask[];
  loadAllNextTasks(missionId: string): PlannedNextTask[];
  writeNextTasks(missionId: string, tasks: PlannedNextTask[]): void;
  reconcileMissionProgress(missionId: string): void;
  markTaskBoardInProgress(missionId: string): void;
  summarizeMissionTaskOutcomes(missionId: string): {
    acceptedCount: number;
    reviewedCount: number;
    completedCount: number;
    requestedCount: number;
  };
}

const PLANNED_NEXT_TASK_STATUS_PRIORITY: Record<string, number> = {
  requested: 0,
  planned: 1,
  rework: 2,
  blocked: 3,
  reviewed: 4,
  accepted: 5,
  completed: 6,
};

const TASK_EVENT_STATUS_MAP: Partial<
  Record<
    NonNullable<PlannedNextTask['status']>,
    'task_reviewed' | 'task_completed' | 'task_accepted'
  >
> = {
  reviewed: 'task_reviewed',
  completed: 'task_completed',
  accepted: 'task_accepted',
};

function safeMissionArtifactPath(missionId: string, relativePath: string): string {
  const missionPath = assertSafeRepositoryPath(
    findMissionPath(missionId) || missionDir(missionId, 'public'),
    {
      allowMissingLeaf: true,
    }
  );
  return assertSafeRepositoryPath(path.join(missionPath, relativePath), {
    allowMissingLeaf: true,
  });
}

export function createMissionProgressController(
  dependencies: MissionProgressControllerDependencies
): MissionProgressController {
  function loadAllNextTasks(missionId: string): PlannedNextTask[] {
    const nextTasksPath = safeMissionArtifactPath(missionId, 'NEXT_TASKS.json');
    if (!safeExistsSync(nextTasksPath)) return [];
    return dependencies.validatePlannedNextTasks(
      loadMissionNextTaskObjectsAtPath(nextTasksPath, path.basename(path.dirname(nextTasksPath))) ||
        [],
      missionId
    );
  }

  function loadPlannedNextTasks(missionId: string): PlannedNextTask[] {
    return loadAllNextTasks(missionId).filter((task) => {
      const status = String(task.status || 'planned');
      return status === 'planned' || status === 'rework';
    });
  }

  function writeNextTasks(missionId: string, tasks: PlannedNextTask[]): void {
    const nextTasksPath = safeMissionArtifactPath(missionId, 'NEXT_TASKS.json');
    const existingTasks = safeExistsSync(nextTasksPath)
      ? dependencies.validatePlannedNextTasks(
          loadMissionNextTaskObjectsAtPath(
            nextTasksPath,
            path.basename(path.dirname(nextTasksPath))
          ) || [],
          missionId
        )
      : [];
    const existingById = new Map(existingTasks.map((task) => [task.task_id, task]));
    const mergedTasks = tasks.map((task) => {
      const existing = existingById.get(task.task_id);
      if (!existing) return task;
      const existingPriority =
        PLANNED_NEXT_TASK_STATUS_PRIORITY[String(existing.status || 'planned')] ?? 0;
      const incomingPriority =
        PLANNED_NEXT_TASK_STATUS_PRIORITY[String(task.status || 'planned')] ?? 0;
      const status = existingPriority > incomingPriority ? existing.status : task.status;
      const rework_count = Math.max(
        Number(existing.rework_count || 0),
        Number(task.rework_count || 0)
      );
      return {
        ...task,
        ...(status ? { status } : {}),
        ...(rework_count > 0 ? { rework_count } : {}),
      };
    });
    writeProvisionedJson({
      missionId,
      filePath: nextTasksPath,
      targetPath: 'NEXT_TASKS.json',
      provisioned: provisionMissionEntry(mergedTasks),
    });
  }

  function syncPlanningArtifacts(missionId: string): void {
    const planPath = safeMissionArtifactPath(missionId, 'PLAN.md');
    const nextTasksPath = safeMissionArtifactPath(missionId, 'NEXT_TASKS.json');
    const taskBoardPath = safeMissionArtifactPath(missionId, 'TASK_BOARD.md');

    if (
      !safeExistsSync(planPath) ||
      !safeExistsSync(nextTasksPath) ||
      !safeExistsSync(taskBoardPath)
    ) {
      return;
    }

    const currentTaskBoard = readTextFile(taskBoardPath);
    const gateSummary = dependencies.summarizeMissionGateState(missionId);
    const gateSection =
      gateSummary.lines.length > 0
        ? [
            '',
            '### Gate Status',
            ...gateSummary.lines,
            `Rework count: ${gateSummary.reworkCount}`,
          ].join('\n')
        : '';
    const updatedTaskBoard = currentTaskBoard
      .replace('## Status: Planned', '## Status: Planning Ready')
      .replace('- [ ] Step 1: Research and Strategy', '- [x] Step 1: Research and Strategy')
      .replace(/(?:\n### Gate Status[\s\S]*?)?$/u, gateSection);

    if (updatedTaskBoard !== currentTaskBoard) {
      writeProvisionedText({
        missionId,
        filePath: taskBoardPath,
        targetPath: 'TASK_BOARD.md',
        provisioned: provisionMissionEntry(updatedTaskBoard),
      });
    }

    const nextTasks = safeExistsSync(nextTasksPath)
      ? loadMissionNextTaskObjectsAtPath(
          nextTasksPath,
          path.basename(path.dirname(nextTasksPath))
        ) || []
      : [];
    ledger.record('MISSION_PLAN_READY', {
      mission_id: missionId,
      role: 'planner',
      summary_path: 'PLAN.md',
      next_tasks_path: 'NEXT_TASKS.json',
      planned_task_count: nextTasks.length,
    });
    emitMissionTaskEvent({
      event_type: 'task_submitted',
      mission_id: missionId,
      task_id: 'planner-initial-plan',
      agent_id: 'nerve-agent',
      team_role: 'planner',
      decision: 'task_submitted',
      why: 'Planner produced PLAN.md and NEXT_TASKS.json for the mission kickoff.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: ['PLAN.md', 'NEXT_TASKS.json'],
      payload: {
        summary_path: 'PLAN.md',
        next_tasks_path: 'NEXT_TASKS.json',
      },
    });
    emitMissionTaskEvent({
      event_type: 'task_completed',
      mission_id: missionId,
      task_id: 'planner-initial-plan',
      agent_id: 'nerve-agent',
      team_role: 'planner',
      decision: 'task_completed',
      why: 'Planner initial planning task completed with mission plan and next tasks.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: ['PLAN.md', 'NEXT_TASKS.json'],
      payload: {
        completion: 'planning_artifacts_ready',
      },
    });
  }

  function persistPlanningPacket(missionId: string, packet: PlanningPacket): void {
    const validation = validatePlanningPacket(packet);
    if (!validation.valid || !validation.value) {
      throw new Error(`Invalid planning packet for ${missionId}: ${validation.errors.join('; ')}`);
    }
    const planPath = safeMissionArtifactPath(missionId, 'PLAN.md');
    writeProvisionedText({
      missionId,
      filePath: planPath,
      targetPath: 'PLAN.md',
      provisioned: provisionMissionEntry(validation.value.plan_markdown.trimEnd() + '\n'),
    });
    const derivedTasks = validation.value.next_tasks.map((task, index) => {
      const taskId =
        typeof task.task_id === 'string' && task.task_id.trim()
          ? task.task_id.trim()
          : `task-${index + 1}`;
      const description = task.description.trim();
      const deliverable =
        typeof task.deliverable === 'string' && task.deliverable.trim()
          ? task.deliverable.trim()
          : undefined;
      const targetPath =
        typeof task.target_path === 'string' && task.target_path.trim()
          ? task.target_path.trim()
          : undefined;
      const dependencies = Array.isArray(task.dependencies)
        ? [
            ...new Set(
              task.dependencies.map((dependency) => String(dependency || '').trim()).filter(Boolean)
            ),
          ]
        : [];
      const acceptanceCriteria =
        Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length > 0
          ? task.acceptance_criteria
              .map((criterion) => String(criterion || '').trim())
              .filter(Boolean)
          : [description];
      const expectedOutputFormat =
        task.expected_output_format || (targetPath ? 'files' : deliverable ? 'files' : 'text');
      const estimatedScope =
        task.estimated_scope ||
        (description.length > 240 || dependencies.length > 1 || targetPath?.includes('/')
          ? 'L'
          : description.length > 120 || deliverable || dependencies.length === 1
            ? 'M'
            : 'S');
      const risk =
        task.risk || (estimatedScope === 'L' ? 'high' : estimatedScope === 'M' ? 'medium' : 'low');
      return {
        task_id: taskId,
        status: 'planned' as const,
        assigned_to: {
          role: task.team_role,
        },
        description,
        ...(deliverable ? { deliverable } : {}),
        ...(targetPath ? { target_path: targetPath } : {}),
        dependencies,
        acceptance_criteria: acceptanceCriteria,
        risk,
        expected_output_format: expectedOutputFormat,
        estimated_scope: estimatedScope,
        ...(typeof task.review_target === 'string' && task.review_target.trim()
          ? { review_target: task.review_target.trim() }
          : {}),
      };
    });
    const nextTasks = validation.value.next_tasks.map((_, index) => ({ ...derivedTasks[index] }));
    // MO-01: process-template-seeded tasks are the mission's fixed skeleton —
    // the planner may add tasks around them but never drop or restructure them.
    const nextTasksPath = safeMissionArtifactPath(missionId, 'NEXT_TASKS.json');
    const seededTasks = readProcessTemplateSeededTasks(nextTasksPath);
    if (seededTasks.length > 0) {
      const seededIds = new Set(seededTasks.map((task) => String(task.task_id)));
      const additions = nextTasks.filter((task) => !seededIds.has(task.task_id));
      writeProvisionedJson({
        missionId,
        filePath: nextTasksPath,
        targetPath: 'NEXT_TASKS.json',
        provisioned: provisionMissionEntry([...seededTasks, ...additions]),
      });
      ledger.record('MISSION_PLAN_MERGED_WITH_PROCESS_TEMPLATE', {
        mission_id: missionId,
        seeded_task_count: seededTasks.length,
        planner_addition_count: additions.length,
        dropped_planner_task_count: nextTasks.length - additions.length,
      });
      return;
    }
    writeProvisionedJson({
      missionId,
      filePath: nextTasksPath,
      targetPath: 'NEXT_TASKS.json',
      provisioned: provisionMissionEntry(nextTasks),
    });
  }

  function readExistingTaskEventKeys(missionId: string): Set<string> {
    const taskEventsPath = assertSafeRepositoryPath(missionTaskEventsPath(missionId), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(taskEventsPath)) return new Set();
    const raw = readTextFile(taskEventsPath);
    return new Set(
      raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return parseMissionTaskEventIdentity(parseSafeJsonInput(line, 'mission task event'));
          } catch {
            return undefined;
          }
        })
        .filter((value): value is MissionTaskEventIdentity => value?.mission_id === missionId)
        .map((value) => `${value.event_type}:${value.task_id}`)
    );
  }

  function reconcileTaskOutcomeEvents(missionId: string): void {
    const tasks = loadAllNextTasks(missionId).filter(
      (task) => task.status && task.status !== 'planned' && task.status !== 'requested'
    );
    const seen = readExistingTaskEventKeys(missionId);

    for (const task of tasks) {
      const eventType = task.status ? TASK_EVENT_STATUS_MAP[task.status] : undefined;
      const teamRole = task.assigned_to?.role;
      if (!eventType || !teamRole) continue;
      const dedupeKey = `${eventType}:${task.task_id}`;
      if (seen.has(dedupeKey)) continue;
      emitMissionTaskEvent({
        event_type: eventType,
        mission_id: missionId,
        task_id: task.task_id,
        agent_id: task.assigned_to?.agent_id,
        team_role: teamRole,
        decision: eventType,
        why: `Task ${task.task_id} transitioned to ${task.status}.`,
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: task.deliverable ? [String(task.deliverable)] : [],
        payload: {
          description: task.description,
          deliverable: task.deliverable,
          status: task.status,
        },
      });
      seen.add(dedupeKey);
    }
  }

  function reconcileMissionProgress(missionId: string): void {
    const taskBoardPath = safeMissionArtifactPath(missionId, 'TASK_BOARD.md');
    if (!safeExistsSync(taskBoardPath)) return;

    const tasks = loadAllNextTasks(missionId);
    const acceptedCount = tasks.filter((task) => task.status === 'accepted').length;
    const reviewedCount = tasks.filter((task) => task.status === 'reviewed').length;
    const completedCount = tasks.filter((task) => task.status === 'completed').length;
    const requestedCount = tasks.filter((task) => task.status === 'requested').length;

    reconcileTaskOutcomeEvents(missionId);

    const currentTaskBoard = readTextFile(taskBoardPath);
    const gateSummary = dependencies.summarizeMissionGateState(missionId);
    const gateSection =
      gateSummary.lines.length > 0
        ? [
            '',
            '### Gate Status',
            ...gateSummary.lines,
            `Rework count: ${gateSummary.reworkCount}`,
          ].join('\n')
        : '';
    let updatedTaskBoard = currentTaskBoard;

    if (acceptedCount > 0) {
      updatedTaskBoard = updatedTaskBoard
        .replace(/## Status: .+/u, '## Status: Review Accepted')
        .replace('- [~] Step 2: Implementation', '- [x] Step 2: Implementation')
        .replace('- [ ] Step 2: Implementation', '- [x] Step 2: Implementation')
        .replace('- [ ] Step 3: Validation', '- [x] Step 3: Validation');
    } else if (reviewedCount > 0 || completedCount > 0) {
      updatedTaskBoard = updatedTaskBoard
        .replace(/## Status: .+/u, '## Status: Validation Ready')
        .replace('- [~] Step 2: Implementation', '- [x] Step 2: Implementation')
        .replace('- [ ] Step 2: Implementation', '- [x] Step 2: Implementation')
        .replace('- [ ] Step 3: Validation', '- [~] Step 3: Validation');
    } else if (requestedCount > 0) {
      updatedTaskBoard = updatedTaskBoard
        .replace(/## Status: .+/u, '## Status: Execution Ready')
        .replace('- [ ] Step 2: Implementation', '- [~] Step 2: Implementation');
    }

    if (gateSection) {
      if (/### Gate Status[\s\S]*$/u.test(updatedTaskBoard)) {
        updatedTaskBoard = updatedTaskBoard.replace(/(?:\n### Gate Status[\s\S]*)$/u, gateSection);
      } else {
        updatedTaskBoard = `${updatedTaskBoard.trimEnd()}${gateSection}\n`;
      }
    }

    if (updatedTaskBoard !== currentTaskBoard) {
      writeProvisionedText({
        missionId,
        filePath: taskBoardPath,
        targetPath: 'TASK_BOARD.md',
        provisioned: provisionMissionEntry(updatedTaskBoard),
      });
    }

    if (acceptedCount > 0 || reviewedCount > 0 || completedCount > 0) {
      ledger.record('MISSION_TASK_OUTCOMES_RECONCILED', {
        mission_id: missionId,
        accepted_count: acceptedCount,
        reviewed_count: reviewedCount,
        completed_count: completedCount,
        requested_count: requestedCount,
      });
    }
  }

  function markTaskBoardInProgress(missionId: string): void {
    const taskBoardPath = safeMissionArtifactPath(missionId, 'TASK_BOARD.md');
    if (!safeExistsSync(taskBoardPath)) return;
    const currentTaskBoard = readTextFile(taskBoardPath);
    const updatedTaskBoard = currentTaskBoard
      .replace('## Status: Planning Ready', '## Status: Execution Ready')
      .replace('- [ ] Step 2: Implementation', '- [~] Step 2: Implementation');
    if (updatedTaskBoard !== currentTaskBoard) {
      writeProvisionedText({
        missionId,
        filePath: taskBoardPath,
        targetPath: 'TASK_BOARD.md',
        provisioned: provisionMissionEntry(updatedTaskBoard),
      });
    }
  }

  function summarizeMissionTaskOutcomes(missionId: string) {
    const tasks = loadAllNextTasks(missionId);
    return {
      acceptedCount: tasks.filter((task) => task.status === 'accepted').length,
      reviewedCount: tasks.filter((task) => task.status === 'reviewed').length,
      completedCount: tasks.filter((task) => task.status === 'completed').length,
      requestedCount: tasks.filter((task) => task.status === 'requested').length,
    };
  }

  return {
    syncPlanningArtifacts,
    persistPlanningPacket,
    loadPlannedNextTasks,
    loadAllNextTasks,
    writeNextTasks,
    reconcileMissionProgress,
    markTaskBoardInProgress,
    summarizeMissionTaskOutcomes,
  };
}

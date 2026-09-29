import type { ProjectBootstrapWorkItem } from './project-registry.js';
import type { WorkItem } from '../workforce/work-coordination.js';

export function projectLineageTasks(
  bootstrapTasks: ProjectBootstrapWorkItem[],
  workItems: WorkItem[],
  kickoffTaskSessionId?: string
): Array<{
  work_id: string;
  title: string;
  status: string;
  task_session_id?: string;
  role: 'work_item';
}> {
  const remaining = new Map(bootstrapTasks.map((task) => [task.work_id, task]));
  const canonicalTasks = workItems.map((item) => {
    const workId = item.context?.task_id || item.item_id;
    const bootstrap = remaining.get(workId) || remaining.get(item.item_id);
    remaining.delete(workId);
    remaining.delete(item.item_id);
    return {
      work_id: workId,
      title: item.title,
      status: item.status,
      ...(bootstrap?.kind === 'task_session' && kickoffTaskSessionId
        ? { task_session_id: kickoffTaskSessionId }
        : {}),
      role: 'work_item' as const,
    };
  });
  const legacyTasks = Array.from(remaining.values(), (task) => ({
    work_id: task.work_id,
    title: task.title,
    status: task.status,
    ...(task.kind === 'task_session' && kickoffTaskSessionId
      ? { task_session_id: kickoffTaskSessionId }
      : {}),
    role: 'work_item' as const,
  }));
  return [...canonicalTasks, ...legacyTasks];
}

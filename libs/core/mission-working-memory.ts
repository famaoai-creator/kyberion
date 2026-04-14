import { randomUUID } from 'node:crypto';

export type MissionWorkingMemoryScope = 'mission' | 'task' | 'agent';

export interface MissionWorkingMemoryEntry {
  entry_id: string;
  mission_id: string;
  scope: MissionWorkingMemoryScope;
  key: string;
  value: string;
  writer_agent: string;
  task_id?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export class MissionWorkingMemory {
  private readonly entries: MissionWorkingMemoryEntry[] = [];

  write(input: {
    mission_id: string;
    scope?: MissionWorkingMemoryScope;
    key: string;
    value: string;
    writer_agent: string;
    task_id?: string;
    metadata?: Record<string, unknown>;
  }): MissionWorkingMemoryEntry {
    const entry: MissionWorkingMemoryEntry = {
      entry_id: `MWM-${randomUUID().slice(0, 8).toUpperCase()}`,
      mission_id: input.mission_id.toUpperCase(),
      scope: input.scope || 'mission',
      key: input.key,
      value: input.value,
      writer_agent: input.writer_agent,
      task_id: input.task_id,
      created_at: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.entries.push(entry);
    return entry;
  }

  list(input: { missionId: string; scope?: MissionWorkingMemoryScope; taskId?: string; writerAgent?: string }): MissionWorkingMemoryEntry[] {
    return this.entries.filter((entry) => {
      if (entry.mission_id !== input.missionId.toUpperCase()) return false;
      if (input.scope && entry.scope !== input.scope) return false;
      if (input.taskId && entry.task_id !== input.taskId) return false;
      if (input.writerAgent && entry.writer_agent !== input.writerAgent) return false;
      return true;
    });
  }

  summarize(missionId: string): string {
    const entries = this.list({ missionId });
    if (entries.length === 0) return '';
    const sections = new Map<string, MissionWorkingMemoryEntry[]>();
    for (const entry of entries) {
      const group = `${entry.scope}:${entry.writer_agent}`;
      const list = sections.get(group) || [];
      list.push(entry);
      sections.set(group, list);
    }
    const lines: string[] = ['## Mission Working Memory', ''];
    for (const [group, groupEntries] of sections) {
      lines.push(`### ${group}`);
      for (const entry of groupEntries) {
        const value = entry.value.length > 200 ? `${entry.value.slice(0, 197)}…` : entry.value;
        lines.push(`- ${entry.key}: ${value}`);
      }
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }
}

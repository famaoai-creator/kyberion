import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

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

function mwmPersistPath(missionId: string): string {
  const missionPath = pathResolver.findMissionPath(missionId.toUpperCase())
    ?? pathResolver.active(path.join('missions', 'confidential', missionId.toUpperCase()));
  return path.join(missionPath, '.mwm-entries.json');
}

function loadEntries(missionId: string): MissionWorkingMemoryEntry[] {
  const p = mwmPersistPath(missionId);
  if (!safeExistsSync(p)) return [];
  try {
    return JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string) as MissionWorkingMemoryEntry[];
  } catch {
    return [];
  }
}

function saveEntries(missionId: string, entries: MissionWorkingMemoryEntry[]): void {
  try {
    const p = mwmPersistPath(missionId);
    const dir = path.dirname(p);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeWriteFile(p, JSON.stringify(entries, null, 2));
  } catch {
    // Disk persistence is best-effort; in-memory entries remain intact.
  }
}

export class MissionWorkingMemory {
  private readonly entries: MissionWorkingMemoryEntry[] = [];
  private readonly persistedMissions = new Set<string>();

  private ensureLoaded(missionId: string): void {
    const key = missionId.toUpperCase();
    if (!this.persistedMissions.has(key)) {
      const persisted = loadEntries(key);
      const existingIds = new Set(this.entries.map(e => e.entry_id));
      for (const e of persisted) {
        if (!existingIds.has(e.entry_id)) this.entries.push(e);
      }
      this.persistedMissions.add(key);
    }
  }

  write(input: {
    mission_id: string;
    scope?: MissionWorkingMemoryScope;
    key: string;
    value: string;
    writer_agent: string;
    task_id?: string;
    metadata?: Record<string, unknown>;
  }): MissionWorkingMemoryEntry {
    const missionId = input.mission_id.toUpperCase();
    this.ensureLoaded(missionId);
    const entry: MissionWorkingMemoryEntry = {
      entry_id: `MWM-${randomUUID().slice(0, 8).toUpperCase()}`,
      mission_id: missionId,
      scope: input.scope || 'mission',
      key: input.key,
      value: input.value,
      writer_agent: input.writer_agent,
      task_id: input.task_id,
      created_at: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.entries.push(entry);
    saveEntries(missionId, this.entries.filter(e => e.mission_id === missionId));
    return entry;
  }

  list(input: { missionId: string; scope?: MissionWorkingMemoryScope; taskId?: string; writerAgent?: string }): MissionWorkingMemoryEntry[] {
    this.ensureLoaded(input.missionId);
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

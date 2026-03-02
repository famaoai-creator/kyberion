import { safeWriteFile, safeReadFile, safeMkdir } from '@agent/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pathResolver from '@agent/core/path-resolver';

export interface MemoryEntry {
  fact: string;
  timestamp: string;
  category?: string;
}

export interface MemoryRegistry {
  facts: MemoryEntry[];
}

export function saveFact(fact: string, category: string = 'general'): MemoryEntry {
  const memoryPath = pathResolver.shared('memory/facts.json');
  const registry: MemoryRegistry = fs.existsSync(memoryPath)
    ? JSON.parse(safeReadFile(memoryPath, { encoding: 'utf8' }) as string)
    : { facts: [] };

  const entry: MemoryEntry = {
    fact,
    category,
    timestamp: new Date().toISOString(),
  };

  registry.facts.push(entry);

  const dir = path.dirname(memoryPath);
  if (!fs.existsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  safeWriteFile(memoryPath, JSON.stringify(registry, null, 2));

  return entry;
}

export function searchMemory(query: string): MemoryEntry[] {
  const memoryPath = pathResolver.shared('memory/facts.json');
  if (!fs.existsSync(memoryPath)) return [];

  const registry: MemoryRegistry = JSON.parse(safeReadFile(memoryPath, { encoding: 'utf8' }) as string);
  return registry.facts.filter(
    (f) =>
      f.fact.toLowerCase().includes(query.toLowerCase()) ||
      (f.category && f.category.toLowerCase().includes(query.toLowerCase()))
  );
}

/**
 * scripts/distill_archived_missions.ts
 * Scans archived missions and compiles a central history document.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeWriteFile } from '@agent/core';

const ROOT_DIR = process.cwd();
const ARCHIVE_DIR = path.join(ROOT_DIR, 'archive/missions');
const HISTORY_PATH = path.join(ROOT_DIR, 'knowledge/operations/mission_history.md');

interface ArchivedMission {
  id: string;
  completedAt: string;
  persona: string;
  summary: string;
}

function scanArchives(): ArchivedMission[] {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  const missions: ArchivedMission[] = [];
  const folders = fs.readdirSync(ARCHIVE_DIR).filter(f => fs.statSync(path.join(ARCHIVE_DIR, f)).isDirectory());

  for (const folder of folders) {
    const missionDir = path.join(ARCHIVE_DIR, folder);
    const statePath = path.join(missionDir, 'mission-state.json');
    const prPath = path.join(missionDir, 'PR_DESCRIPTION.md');
    
    let id = folder;
    let completedAt = fs.statSync(missionDir).mtime.toISOString();
    let persona = 'Unknown';
    let summary = 'No detailed summary available.';

    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        id = state.mission_id || id;
        persona = state.assigned_persona || persona;
        
        const endHistory = state.history?.slice(-1)[0];
        if (endHistory && endHistory.ts) completedAt = endHistory.ts;
      } catch (e) {}
    }

    if (fs.existsSync(prPath)) {
      const prContent = fs.readFileSync(prPath, 'utf8');
      // Extract Overview section
      const overviewMatch = prContent.match(/## 🎯 Overview\n([\s\S]*?)(?=## |$)/);
      if (overviewMatch) {
        summary = overviewMatch[1].trim();
      }
    }

    missions.push({ id, completedAt, persona, summary });
  }

  // Sort newest first
  return missions.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
}

async function distill() {
  logger.info('📚 Distilling archived missions...');
  const missions = scanArchives();

  let md = `# Mission History Ledger\n\n自動生成された、エコシステムの過去の全ミッションの完了記録です。\n\n`;

  for (const m of missions) {
    const date = new Date(m.completedAt).toLocaleDateString();
    md += `## [${date}] ${m.id}\n`;
    md += `- **Persona**: ${m.persona}\n`;
    md += `- **Summary**:\n  > ${m.summary.replace(/\n/g, '\n  > ')}\n\n`;
  }

  const dir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  safeWriteFile(HISTORY_PATH, md);

  logger.success(`✅ Distilled ${missions.length} missions into ${HISTORY_PATH}`);
}

distill().catch(e => logger.error(e.message));

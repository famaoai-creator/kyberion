import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, pathResolver, safeReadFile, safeWriteFile } from '@agent/core';

/**
 * scripts/export_mission.ts
 * Mission Export Tool (MEP v0.1 Prototype)
 * [SECURE-IO COMPLIANT VERSION]
 */

interface ExportOptions {
  missionId: string;
  includeEvidence: boolean;
  outputFile?: string;
}

const SANITIZE_MAP: Record<string, string> = {
  [process.env.HOME || '/Users']: '{{HOME}}',
  [process.cwd()]: '{{PROJECT_ROOT}}',
};

function sanitizeContent(content: string): string {
  let sanitized = content;
  for (const [key, value] of Object.entries(SANITIZE_MAP)) {
    // Escape special characters for regex
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(new RegExp(escapedKey, 'g'), value);
  }
  // Basic Regex for sensitive patterns
  sanitized = sanitized.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '[EMAIL_REDACTED]');
  sanitized = sanitized.replace(/(https?:\/\/)[^\s/$.?#].[^\s]*/g, (match) => {
    if (match.includes('localhost')) return match;
    return '[URL_REDACTED]';
  });
  return sanitized;
}

async function exportMission({ missionId, includeEvidence, outputFile }: ExportOptions) {
  const missionPath = pathResolver.active(`missions/${missionId}`);
  const archivePath = pathResolver.active(`archive/missions/${missionId}`);
  
  const targetPath = fs.existsSync(missionPath) ? missionPath : (fs.existsSync(archivePath) ? archivePath : null);

  if (!targetPath) {
    logger.error(`Mission not found: ${missionId}`);
    process.exit(1);
  }

  logger.info(`📦 Exporting mission: ${missionId} from ${targetPath}`);

  const mep: any = {
    version: '0.1.0',
    exportedAt: new Date().toISOString(),
    missionId,
    metadata: {},
    blueprint: {},
    evidence: []
  };

  try {
    // 1. Collect Metadata (Contract)
    const contractPath = path.join(targetPath, 'contract.json');
    if (fs.existsSync(contractPath)) {
      const contractContent = safeReadFile(contractPath, { encoding: 'utf8' }) as string;
      const contract = JSON.parse(contractContent);
      mep.metadata = {
        goal: contract.goal,
        status: contract.status || 'unknown',
        role: contract.role
      };
      mep.blueprint.contract = JSON.parse(sanitizeContent(JSON.stringify(contract)));
    }

    // 2. Collect Procedure (Task Board)
    const taskBoardPath = path.join(targetPath, 'TASK_BOARD.md');
    if (fs.existsSync(taskBoardPath)) {
      const boardContent = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
      mep.blueprint.procedure = sanitizeContent(boardContent);
    }

    // 3. Collect Evidence
    if (includeEvidence) {
      const evidenceDir = path.join(targetPath, 'evidence');
      if (fs.existsSync(evidenceDir)) {
        const files = fs.readdirSync(evidenceDir);
        for (const file of files) {
          if (file.endsWith('.json') || file.endsWith('.md') || file.endsWith('.log')) {
            const content = safeReadFile(path.join(evidenceDir, file), { encoding: 'utf8' }) as string;
            mep.evidence.push({
              name: file,
              content: file.endsWith('.json') ? JSON.parse(sanitizeContent(content)) : sanitizeContent(content)
            });
          }
        }
      }
    }

    // 4. Output
    const resultJson = JSON.stringify(mep, null, 2);
    const outPath = outputFile || path.join(process.cwd(), 'hub/exports/missions', `mep_${missionId}.json`);
    safeWriteFile(outPath, resultJson);
    
    logger.success(`✅ Mission exported successfully to: ${outPath}`);
  } catch (err: any) {
    logger.error(`Export failed: ${err.message}`);
  }
}

// CLI Entry
const args = process.argv.slice(2);
const mId = args[0];
const evFlag = args.includes('--evidence');

if (!mId) {
  console.log('Usage: node scripts/export_mission.ts <mission-id> [--evidence]');
  process.exit(1);
}

exportMission({
  missionId: mId,
  includeEvidence: evFlag || true,
}).catch(err => {
  logger.error(`Export failed: ${err.message}`);
});

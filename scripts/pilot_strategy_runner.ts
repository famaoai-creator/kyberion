import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core';

async function main() {
  const strategy = `
# Kyberion AI Consulting: Go-to-Market Strategy
## Target: Japanese Mid-sized Enterprise (SMB) Managers

### 1. Value Proposition: "Safety through Governance"
- **Automated Compliance:** AI handles the tedious task of ensuring all internal processes meet Japanese corporate standards.
- **Simplicity through Intents:** Managers don't need to know 'how' it works, only 'what' they want to achieve.

### 2. Market Strategy (Japanese SMB Focus)
- **Phase 1 (Education):** Host webinars on "How AI can solve the 2024 Logistics/Labor Crisis".
- **Phase 2 (Pilot):** 3-month trial focusing on document automation and decision support.
- **Phase 3 (Expansion):** Full organization work-loop engine implementation.

### 3. Key Benefits
- Reduction in administrative overhead by 40%.
- 100% audit trail for all AI-driven decisions.
  `;

  const outputDir = pathResolver.missionEvidenceDir('STRATEGY-PILOT-01') || pathResolver.active('missions/STRATEGY-PILOT-01/evidence');
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'gtm_strategy.md');
  safeWriteFile(outputPath, strategy.trim());
  console.log(`✅ Strategy successfully distilled and saved to: ${outputPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

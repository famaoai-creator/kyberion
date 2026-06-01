import * as path from 'node:path';
import { pathResolver, resolvePilotStrategyPolicy, safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core';

async function main() {
  const policy = resolvePilotStrategyPolicy();
  const strategy = `
# ${policy.title}
## Target: ${policy.target}

### 1. ${policy.value_proposition_title}
- **Automated Compliance:** AI handles the tedious task of ensuring all internal processes meet Japanese corporate standards.
- **Simplicity through Intents:** Managers don't need to know 'how' it works, only 'what' they want to achieve.

### 2. ${policy.market_strategy_title}
- **Phase 1 (${policy.phase_titles.education}):** Host webinars on "How AI can solve the 2024 Logistics/Labor Crisis".
- **Phase 2 (${policy.phase_titles.pilot}):** 3-month trial focusing on document automation and decision support.
- **Phase 3 (${policy.phase_titles.expansion}):** Full organization work-loop engine implementation.

### 3. ${policy.key_benefits_title}
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

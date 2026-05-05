import * as path from 'node:path';
import { 
  pathResolver, 
  safeReadFile, 
  safeWriteFile,
  safeExistsSync,
  logger 
} from '@agent/core';

async function main() {
  const rootDir = pathResolver.rootDir();
  const tiers = ['public', 'confidential', 'personal'];
  let markdown = '# Kyberion Capabilities Guide (Auto-generated)\n\n';
  markdown += `Last Updated: ${new Date().toISOString()}\n\n`;

  // 1. Scan Registries
  for (const tier of tiers) {
    markdown += `## Tier: ${tier.toUpperCase()}\n\n`;
    
    // Harness Registries
    const harnessPath = path.resolve(rootDir, tier === 'public' ? 'knowledge/public/governance' : `knowledge/${tier}/governance`, 'harness-capability-registry.json');
    if (safeExistsSync(harnessPath)) {
      const registry = JSON.parse(safeReadFile(harnessPath, { encoding: 'utf8' }) as string);
      markdown += `### CLI Capabilities (Harness)\n`;
      for (const cap of registry.capabilities) {
        markdown += `- **${cap.capability_id}**: ${cap.notes || cap.description || 'No description'}\n`;
      }
      markdown += '\n';
    }

    // Gateway Registries
    const gatewayPath = path.resolve(rootDir, tier === 'public' ? 'knowledge/public/governance' : `knowledge/${tier}/governance`, 'gateway-capability-registry.json');
    if (safeExistsSync(gatewayPath)) {
      const registry = JSON.parse(safeReadFile(gatewayPath, { encoding: 'utf8' }) as string);
      markdown += `### SaaS/API Capabilities (Gateway)\n`;
      for (const cap of registry.capabilities) {
        markdown += `- **${cap.capability_id}**: Registered at ${cap.adapter_profile_path}\n`;
      }
      markdown += '\n';
    }
  }

  const outputPath = path.resolve(rootDir, 'CAPABILITIES_GUIDE.md');
  safeWriteFile(outputPath, markdown);
  console.log(JSON.stringify({ status: 'success', path: outputPath }));
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});

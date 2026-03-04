import { scanForConfidentialMarkers } from '@agent/core/tier-guard';

/**
 * Plugin: Tier Boundary Enforcer
 *
 * Validates that skill outputs respect the 3-tier sovereign knowledge hierarchy.
 * After each skill execution, scans the output data for confidential markers.
 */

export const afterSkill = (skillName: string, output: any) => {
  if (output.status !== 'success' || !output.data) return;

  // Serialize output data and scan for confidential markers
  let text = '';
  try {
    text = typeof output.data === 'string' ? output.data : JSON.stringify(output.data);
  } catch (_e) {
    return;
  }

  const result = scanForConfidentialMarkers(text);
  if (result.hasMarkers) {
    console.error(
      `[TierEnforcer] ⚠️  ${skillName} output contains ${result.markers.length} confidential marker(s): ${result.markers.join(', ')}`
    );
  }
};

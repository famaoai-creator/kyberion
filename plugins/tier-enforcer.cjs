/**
 * Plugin: Tier Boundary Enforcer
 *
 * Validates that skill outputs respect the 3-tier sovereign knowledge hierarchy.
 * After each skill execution, scans the output data for confidential markers.
 * If markers are found in a public-tier context, issues a warning.
 */

let tierGuard;
try {
  tierGuard = require('@agent/core/tier-guard');
} catch (_e) {
  tierGuard = null;
}

module.exports = {
  afterSkill(skillName, output) {
    if (!tierGuard || output.status !== 'success' || !output.data) return;

    // Serialize output data and scan for confidential markers
    let text = '';
    try {
      text = typeof output.data === 'string' ? output.data : JSON.stringify(output.data);
    } catch (_e) {
      return;
    }

    const result = tierGuard.scanForConfidentialMarkers(text);
    if (result.hasMarkers) {
      console.error(
        `[TierEnforcer] ⚠️  ${skillName} output contains ${result.markers.length} confidential marker(s): ${result.markers.join(', ')}`
      );
    }
  },
};

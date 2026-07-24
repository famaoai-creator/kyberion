/**
 * Test-only fixture for libs/core/skill-plugin-loader.test.ts and
 * libs/core/skill-wrapper.test.ts.
 *
 * Lives inside plugins/ (this repo's own tree) specifically so
 * `derivePluginTrustLabel` resolves it as `official` — proving that an
 * official plugin's hooks actually run through the KD-06 load-time gate.
 * It is checked in (rather than written at test time) because runtime
 * writes into `plugins/` are denied by the write-permission policy
 * (`knowledge/product/governance/security-policy.json` has no
 * `default_allow`/role entry for `plugins/`), which is exactly the kind of
 * write this fixture must never need in the first place.
 *
 * Inert unless `KYBERION_SKILL_PLUGIN_TEST_MARKER` is set: hooks then append
 * a line to that file so tests can observe whether they actually fired.
 */
import { appendFileSync } from 'node:fs';

function marker() {
  return process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER;
}

export const beforeSkill = (skillName) => {
  const markerPath = marker();
  if (!markerPath) return;
  appendFileSync(markerPath, `before:${skillName}\n`);
};

export const afterSkill = (skillName, output) => {
  const markerPath = marker();
  if (!markerPath) return;
  appendFileSync(markerPath, `after:${skillName}:${output && output.status}\n`);
};

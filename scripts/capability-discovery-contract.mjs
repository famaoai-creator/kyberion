/**
 * Pure capability status evaluation shared by the full and build-free
 * discovery entrypoints. Keep manifest interpretation in one place so the
 * fallback cannot silently disagree with the governed runtime scanner.
 */
export function evaluateCapabilityContract(capability, platform, binaryAvailable, envAvailable) {
  const platforms = Array.isArray(capability.platforms) ? capability.platforms : [];
  const requirements = capability.requirements ?? {};
  const platformMatch = platforms.includes(platform);
  const missingBins = (requirements.bin ?? []).filter((bin) => !binaryAvailable(bin));
  const envPlatforms = requirements.env_platforms;
  const environmentApplies =
    !envPlatforms || envPlatforms.length === 0 || envPlatforms.includes(platform);
  const missingEnv = environmentApplies
    ? (requirements.env ?? []).filter((name) => !envAvailable(name))
    : [];

  return {
    op: String(capability.op || ''),
    platforms,
    platformMatch,
    missingBins,
    missingEnv,
    available: platformMatch && missingBins.length === 0 && missingEnv.length === 0,
  };
}

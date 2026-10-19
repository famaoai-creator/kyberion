import type { ProviderTierAvailabilityReport } from '@agent/core/provider/provider-egress-gate';
type Availability = Pick<ProviderTierAvailabilityReport, 'policy_status' | 'tiers'> &
  Partial<Pick<ProviderTierAvailabilityReport, 'tenant_slug' | 'tenant_source'>>;
export function formatMissionExecutionReadiness(input: {
  tier: string;
  tenantSlug?: string;
  structural: string;
  runtimeReason: string;
  providers: Array<{ provider: string; installed: boolean; healthy: boolean }>;
  availability: Availability | null;
}): string[] {
  const lines = [
    '  Evidence:    structural ' + input.structural + '; not proof of model execution',
    '  Runtime:     runtime unverified — ' + input.runtimeReason,
  ];
  const report = input.availability;
  const scopeMatches =
    input.tier === 'public' ||
    Boolean(
      input.tenantSlug &&
      report?.tenant_slug === input.tenantSlug &&
      report.tenant_source === 'argument'
    );
  const tier =
    report?.policy_status === 'ok' && scopeMatches
      ? report.tiers.find((item) => item.tier === input.tier)
      : undefined;
  if (!tier) lines.push('  Permission:  permission unverified for this mission scope');
  const installed = input.providers.filter((provider) => provider.installed);
  if (!installed.length)
    lines.push('  Providers:   No installed provider observation; runtime unverified');
  if (tier) {
    for (const denied of tier.denied) {
      if (!installed.some((provider) => provider.provider === denied.provider)) {
        lines.push(
          '  Permission:  ' +
            denied.provider +
            ': blocked — ' +
            denied.reason +
            '; installation unobserved'
        );
      }
    }
  }
  for (const provider of installed) {
    const denied = tier?.denied.find((entry) => entry.provider === provider.provider);
    const allowed = tier?.usable.find((entry) => entry.provider === provider.provider);
    const permission = denied
      ? 'blocked — ' + denied.reason
      : allowed
        ? 'egress allowed (' + allowed.basis + '); runtime unverified'
        : 'permission unverified';
    lines.push(
      '  Provider:    ' +
        provider.provider +
        ': ' +
        permission +
        '; cached health=' +
        (provider.healthy ? 'healthy' : 'unhealthy')
    );
  }
  lines.push(
    '  Check:       Revalidate permission and runtime before execution; inspect execution receipts for actual outcomes.'
  );
  return lines;
}

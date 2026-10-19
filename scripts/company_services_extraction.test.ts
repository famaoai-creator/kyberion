import { describe, expect, it, vi } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { bootstrapCompany, listCompanyVerticals } from '@agent/core/organization/company-bootstrap';
import { onboardAiCompany } from '@agent/core/organization/company-onboarding';
import * as coreProbe from '@agent/core/organization/tenant-activation-probe';
import { runCheck } from '@agent/core/organization/tenant-registry-consistency';
import * as registryCore from '@agent/core/organization/tenant-registry-consistency';
import { parseJsonProbeOutput, runServicePreflight } from '@agent/core/service/service-preflight';
import * as bootstrapCli from './company_bootstrap.js';
import * as onboardingCli from './company_onboarding.js';
import * as probeCli from './tenant_activation_probe.js';
import * as registryCli from './check_tenant_registry_consistency.js';
import * as serviceCli from './service_preflight.js';

const CORE_SERVICES = [
  'organization/company-bootstrap',
  'organization/company-onboarding',
  'organization/tenant-activation-probe',
  'organization/tenant-registry-consistency',
  'service/service-preflight',
];

describe('canonical company onboarding services', () => {
  it('keeps existing CLI exports wired to the same reusable implementations', () => {
    expect(bootstrapCli.bootstrapCompany).toBe(bootstrapCompany);
    expect(bootstrapCli.listCompanyVerticals).toBe(listCompanyVerticals);
    expect(onboardingCli.onboardAiCompany).toBe(onboardAiCompany);
    expect(registryCli.runCheck).toBe(runCheck);
    expect(serviceCli.runServicePreflight).toBe(runServicePreflight);
    expect(serviceCli.parseJsonProbeOutput).toBe(parseJsonProbeOutput);
  });

  it('delegates CLI probes to the core runner while retaining the global audit dependency', async () => {
    const check = { passed: false, detail: 'fixture' };
    const result = {
      passed: false,
      evidence_ref: 'fixture',
      activate_command: null,
      results: {
        isolation_probe: check,
        viewer_scope: check,
        nhi_provisioned: check,
        service_readiness: check,
      },
    };
    const run = vi.spyOn(coreProbe, 'runTenantActivationProbes').mockResolvedValue(result);
    const globalCheck = vi
      .spyOn(registryCore, 'runCheck')
      .mockReturnValue({ exitCode: 0, output: 'global audit fixture' });
    try {
      const input = {
        customerSlug: 'acme',
        tenantSlug: 'acme',
        organizationId: 'acme',
        nhiIds: [],
        serviceIds: [],
      };
      expect(await probeCli.runTenantActivationProbes(input)).toBe(result);
      expect(run).toHaveBeenCalledWith(
        input,
        expect.objectContaining({ registryCheck: expect.any(Function) })
      );
      expect(run.mock.calls[0][1]?.registryCheck()).toEqual({
        exitCode: 0,
        output: 'global audit fixture',
        scope: 'global',
      });
      expect(globalCheck).toHaveBeenCalledOnce();
      const injected = coreProbe.createTenantActivationProbeDeps(input);
      expect(await probeCli.runTenantActivationProbes(input, injected)).toBe(result);
      expect(run).toHaveBeenLastCalledWith(input, injected);
    } finally {
      run.mockRestore();
      globalCheck.mockRestore();
    }
  });

  it.each(CORE_SERVICES)(
    '%s stays independent of executable scripts and CLI harnesses',
    (module) => {
      const source = readTextFile(pathResolver.rootResolve('libs/core/' + module + '.ts'));
      expect(source).not.toMatch(/(?:from|import\s*\()\s*['"][^'"]*scripts\//);
      expect(source).not.toContain('defineScript(');
      expect(source).not.toContain('isDirectScript(');
      expect(source).not.toContain('process.exit(');
    }
  );

  it('keeps scoped probe defaults independent of global registry audit authority', () => {
    const source = readTextFile(
      pathResolver.rootResolve('libs/core/organization/tenant-activation-probe.ts')
    );
    expect(source).not.toContain('tenant-registry-consistency');
    expect(source).not.toContain('withExecutionContext');
    expect(source).toContain("from '../service/service-preflight.js'");
    expect(source).toContain('createTenantActivationProbeDeps(input)');
  });
});

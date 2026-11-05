import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Customer onboarding contract', () => {
  it('offers customer overlay setup in the onboarding wizard and docs', () => {
    const wizard = read('scripts/onboarding_wizard.ts');
    const readme = read('customer/README.md');
    const operator = read('docs/operator/DEPLOYMENT.md');
    const init = read('docs/INITIALIZATION.md');
    const quickstart = read('docs/QUICKSTART.md');
    const ux = read('docs/OPERATOR_UX_GUIDE.md');
    const cli = read('scripts/cli.ts');
    // SX: the help renderer was split out of scripts/cli.ts into
    // scripts/cli-presentation.ts; the cli still owns the entrypoint.
    const cliPresentation = read('scripts/cli-presentation.ts');
    const dashboard = read('scripts/sovereign_dashboard.ts');
    const localDev = read('docs/developer/LOCAL_DEV.md');

    expect(wizard).toContain('Set up a stance (act as another entity) now?');
    expect(wizard).toContain('stance_create');
    expect(wizard).toContain('stance_switch');
    expect(readme).toContain('pnpm stance:switch acme-corp');
    expect(operator).toContain('pnpm stance:create customer-slug');
    expect(operator).toContain(
      'interactive identity setup → active stance overlay / personal fallback'
    );
    expect(operator).toContain('/app/customer');
    expect(init).toContain('knowledge/personal/stances/{slug}/my-identity.json');
    expect(init).toContain(
      'When `KYBERION_STANCE` is unset, it is `knowledge/personal/my-identity.json`'
    );
    expect(quickstart).toContain(
      'knowledge/personal/stances/{slug}/ preferred when KYBERION_STANCE is set'
    );
    expect(ux).toContain('connection material goes in the active private overlay');
    expect(ux).toContain('otherwise `knowledge/personal/connections/`');
    // UX-03: the cli help line moved into the vocabulary catalog (en/ja);
    // the cli must still render it via its key.
    const vocabulary = read('knowledge/product/orchestration/user-facing-vocabulary.json');
    expect(vocabulary).toContain(
      'knowledge/personal/stances/{slug}/ preferred when KYBERION_STANCE is set'
    );
    // DS-08: help dispatch moved from cli.ts into cli-command-handlers.ts;
    // the contract is that the CLI still renders help via printHelp.
    const cliCommandHandlers = read('scripts/cli-command-handlers.ts');
    expect(cli).toContain("from './cli-command-handlers.js'");
    expect(cliCommandHandlers).toContain("from './cli-presentation.js'");
    expect(cliCommandHandlers).toContain('printHelp');
    expect(cliPresentation).toContain("t('cli_help_onboard', locale)");
    expect(dashboard).toContain('customer/{slug}/ preferred when KYBERION_STANCE is set');
    expect(localDev).toContain(
      'Customer-specific identity, connections, and onboarding artifacts resolve under knowledge/personal/stances/{slug}/ when set'
    );
  });
});

import { main as bootstrapCompanyMain } from './company_bootstrap.js';
import { main as onboardCompanyMain } from './company_onboarding.js';
import { main as applyOnboardingMain } from './onboarding_apply.js';
import { main as resetOnboardingMain } from './onboarding_reset.js';
import { runOnboarding as runOnboardingWizard } from './onboarding_wizard.js';
import { currentProcessArgv, defineScript, isDirectScript } from './lib/harness.js';

/**
 * Single onboarding facade. The legacy implementations remain focused and
 * reusable, while public callers use one `onboard` namespace.
 */
export async function main(
  args: string[] = currentProcessArgv().slice(2),
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  if (args[0] === 'apply') {
    await applyOnboardingMain(args.slice(1), print);
    return;
  }
  if (args[0] === 'reset') {
    await resetOnboardingMain(args.slice(1), print);
    return;
  }
  if (args[0] === 'company' && args[1] === 'bootstrap') {
    const status = bootstrapCompanyMain(args.slice(2), print);
    if (status !== 0) throw new Error(`onboard company bootstrap failed with exit code ${status}`);
    return;
  }
  if (args[0] === 'company') {
    const status = onboardCompanyMain(args.slice(args[1] === 'onboard' ? 2 : 1), print);
    if (status !== 0) throw new Error(`onboard company failed with exit code ${status}`);
    return;
  }
  await runOnboardingWizard(args, print);
}

export const runOnboarding = defineScript({
  name: 'onboard',
  flags: ['json', 'dry-run', 'quiet'],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'onboarding.ts') ||
  isDirectScript(import.meta.url, 'onboarding.js')
)
  void runOnboarding();

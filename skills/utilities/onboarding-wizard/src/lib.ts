/**
 * Onboarding Wizard Core Library.
 */

export interface OnboardingState {
  step: number;
  completedSteps: string[];
}

export function nextStep(state: OnboardingState): OnboardingState {
  return {
    ...state,
    step: state.step + 1
  };
}

export function generateWelcomeMessage(userName: string): string {
  return `Welcome to the Gemini Skills Ecosystem, ${userName}! Let's get you started.`;
}

export function detectPrerequisites(): string[] {
  return ['Node.js v18+', 'pnpm', 'Git'];
}

export function generateSetupSteps(): string[] {
  return [
    'Run `pnpm install`',
    'Run `node scripts/init_wizard.cjs`',
    'Execute your first skill via `gemini-cli run ...`'
  ];
}

import {
  runAsyncSkill,
  runSkill,
  runSkillAsync,
  runSkillAsyncCli,
  runSkillCli,
  wrapSkill,
  wrapSkillAsync,
} from './skill-wrapper.js';

export const wrapCapability = wrapSkill;
export const wrapCapabilityAsync = wrapSkillAsync;
export const runCapability = runSkill;
export const runCapabilityAsync = runSkillAsync;
export const runCapabilityCli = runSkillCli;
export const runCapabilityAsyncCli = runSkillAsyncCli;
export const runAsyncCapability = runAsyncSkill;

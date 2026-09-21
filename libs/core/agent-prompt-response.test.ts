import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideAgentPromptResponse,
  mergeAgentPromptResponsePolicies,
  resolveAgentLaunchArgs,
  unusableRuleReason,
  type AgentPromptResponsePolicy,
} from './agent-prompt-response.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const base: AgentPromptResponsePolicy = {
  version: '1.0.0',
  relay_keys: { default: { approve: ['enter'], reject: ['esc'] } },
  escalation_wait_ms: 1000,
};

const context = (over: Partial<Parameters<typeof decideAgentPromptResponse>[1]> = {}) => ({
  signatureId: 'workspace_trust',
  provider: 'agy',
  kind: 'agy',
  cwd: '/work/repo',
  excerpt: 'Do you trust the contents of this project?',
  ...over,
});

describe('decideAgentPromptResponse', () => {
  it('escalates everything by default', () => {
    const decision = decideAgentPromptResponse(base, context());
    expect(decision.action).toBe('escalate');
  });

  it('keeps sign-in and device codes with a person, not the approval queue', () => {
    expect(decideAgentPromptResponse(base, context({ signatureId: 'sign_in' })).action).toBe(
      'human_only'
    );
    expect(decideAgentPromptResponse(base, context({ signatureId: 'device_code' })).action).toBe(
      'human_only'
    );
  });

  it('escalates terms rather than auto-accepting them, whatever a rule says', () => {
    const policy = {
      ...base,
      auto_answer: [{ id: 'x', signature: 'terms_or_consent' as never, keys: ['enter'] }],
    };
    expect(
      decideAgentPromptResponse(policy, context({ signatureId: 'terms_or_consent' })).action
    ).toBe('escalate');
  });

  it('ignores a confirmation rule that would answer any question', () => {
    const policy: AgentPromptResponsePolicy = {
      ...base,
      auto_answer: [{ id: 'yes-to-all', signature: 'generic_confirm', keys: ['y'] }],
    };
    const decision = decideAgentPromptResponse(
      policy,
      context({ signatureId: 'generic_confirm', excerpt: 'Delete everything? (y/n)' })
    );
    expect(decision.action).toBe('escalate');
    expect(unusableRuleReason(policy.auto_answer![0])).toMatch(/excerpt_pattern/);
  });

  it('answers a confirmation only when its text matches', () => {
    const policy: AgentPromptResponsePolicy = {
      ...base,
      auto_answer: [
        {
          id: 'lint-fix',
          signature: 'generic_confirm',
          excerpt_pattern: '^run the linter\\?',
          keys: ['y', 'enter'],
        },
      ],
    };
    expect(
      decideAgentPromptResponse(
        policy,
        context({ signatureId: 'generic_confirm', excerpt: 'Run the linter? (y/n)' })
      ).action
    ).toBe('auto_answer');
    expect(
      decideAgentPromptResponse(
        policy,
        context({ signatureId: 'generic_confirm', excerpt: 'Delete the repo? (y/n)' })
      ).action
    ).toBe('escalate');
  });

  it('requires a trust rule to name paths', () => {
    expect(unusableRuleReason({ id: 't', signature: 'workspace_trust', keys: ['enter'] })).toMatch(
      /cwd_prefixes/
    );
  });

  it('matches a trust rule on a path boundary, not a string prefix', () => {
    const policy: AgentPromptResponsePolicy = {
      ...base,
      auto_answer: [
        { id: 't', signature: 'workspace_trust', cwd_prefixes: ['/work/repo'], keys: ['enter'] },
      ],
    };
    expect(decideAgentPromptResponse(policy, context({ cwd: '/work/repo/sub' })).action).toBe(
      'auto_answer'
    );
    expect(decideAgentPromptResponse(policy, context({ cwd: '/work/repo-evil' })).action).toBe(
      'escalate'
    );
  });

  it('expands {repo_parent} so sibling worktrees can be trusted together', () => {
    const policy: AgentPromptResponsePolicy = {
      ...base,
      auto_answer: [
        { id: 't', signature: 'workspace_trust', cwd_prefixes: ['{repo_parent}'], keys: ['enter'] },
      ],
    };
    const sibling = path.join(path.dirname(pathResolver.rootDir()), 'kyberion-some-worktree');
    expect(decideAgentPromptResponse(policy, context({ cwd: sibling })).action).toBe('auto_answer');
  });

  it('limits a rule to the providers it names', () => {
    const policy: AgentPromptResponsePolicy = {
      ...base,
      auto_answer: [
        {
          id: 't',
          signature: 'workspace_trust',
          providers: ['cursor'],
          cwd_prefixes: ['/work'],
          keys: ['enter'],
        },
      ],
    };
    expect(decideAgentPromptResponse(policy, context()).action).toBe('escalate');
    expect(decideAgentPromptResponse(policy, context({ provider: 'cursor' })).action).toBe(
      'auto_answer'
    );
  });
});

describe('policy overlay', () => {
  it('adds personal rules and lets them replace a product rule by id', () => {
    const merged = mergeAgentPromptResponsePolicies(
      {
        ...base,
        auto_answer: [
          { id: 'a', signature: 'update_available', keys: ['n'] },
          { id: 'b', signature: 'update_available', keys: ['n'] },
        ],
        launch_args: { codex: ['-s', 'workspace-write'] },
      },
      {
        auto_answer: [
          { id: 'b', signature: 'update_available', keys: ['esc'] },
          { id: 'c', signature: 'workspace_trust', cwd_prefixes: ['/w'], keys: ['enter'] },
        ],
        launch_args: { claude: ['--permission-mode', 'acceptEdits'] },
        escalation_wait_ms: 0,
      }
    );
    expect(merged.auto_answer!.map((rule) => [rule.id, rule.keys[0]])).toEqual([
      ['a', 'n'],
      ['b', 'esc'],
      ['c', 'enter'],
    ]);
    expect(resolveAgentLaunchArgs(merged, 'codex')).toEqual(['-s', 'workspace-write']);
    expect(resolveAgentLaunchArgs(merged, 'claude')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(merged.escalation_wait_ms).toBe(0);
  });

  it('ships a product policy that answers nothing and adds no flags', () => {
    // The product file only; an installation's personal overlay is its own business.
    const product = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/governance/agent-prompt-response-policy.json'), {
        encoding: 'utf8',
      }) as string
    ) as AgentPromptResponsePolicy;
    expect(product.auto_answer).toEqual([]);
    expect(product.launch_args).toEqual({});
  });
});

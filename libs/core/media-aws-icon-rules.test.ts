import { describe, expect, it } from 'vitest';
import { loadMediaAwsIconRuleCatalog, resolveMediaAwsIconCandidates } from './media-aws-icon-rules.js';

describe('media-aws-icon-rules', () => {
  it('resolves rule-based aws icon candidates', () => {
    const catalog = loadMediaAwsIconRuleCatalog();

    expect(catalog.rules.length).toBeGreaterThan(0);
    expect(resolveMediaAwsIconCandidates('aws_iam_role')).toContain(
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png'
    );
    expect(resolveMediaAwsIconCandidates('my_cloudwatch_alarm')).toContain(
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.png'
    );
    expect(resolveMediaAwsIconCandidates('custom')).toEqual([]);
  });
});

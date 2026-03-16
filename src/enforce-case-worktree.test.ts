import { describe, it, expect } from 'vitest';

/**
 * Tests the branch pattern from enforce-case-worktree.sh.
 * Must be kept in sync with the grep regex in the hook.
 */
function matchesBranchPattern(branch: string): boolean {
  // Mirror of enforce-case-worktree.sh line 21:
  // grep -qE '^(case/|skill/|[0-9]{6}-|feat/|worktree-)'
  const pattern = /^(case\/|skill\/|[0-9]{6}-|feat\/|worktree-)/;
  return pattern.test(branch);
}

describe('enforce-case-worktree branch pattern', () => {
  it('allows case/ branches', () => {
    expect(matchesBranchPattern('case/fix-auth')).toBe(true);
  });
  it('allows skill/ branches', () => {
    expect(matchesBranchPattern('skill/usage-tracking')).toBe(true);
  });
  it('allows feat/ branches', () => {
    expect(matchesBranchPattern('feat/new-feature')).toBe(true);
  });
  it('allows 2026 date branches', () => {
    expect(matchesBranchPattern('260315-fix-auth')).toBe(true);
  });
  it('allows 2027 date branches', () => {
    expect(matchesBranchPattern('270101-new-feature')).toBe(true);
  });
  it('allows 2028 date branches', () => {
    expect(matchesBranchPattern('280615-another-fix')).toBe(true);
  });
  it('allows worktree- prefixed branches', () => {
    expect(matchesBranchPattern('worktree-260316-fix-stuff')).toBe(true);
  });
  it('blocks main', () => {
    expect(matchesBranchPattern('main')).toBe(false);
  });
  it('blocks random branch names', () => {
    expect(matchesBranchPattern('my-branch')).toBe(false);
  });
  it('blocks develop', () => {
    expect(matchesBranchPattern('develop')).toBe(false);
  });
});

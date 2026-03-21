import { describe, it, expect } from 'vitest';
import {
  stripHeredocBody,
  isGhPrCommand,
  isGitCommand,
  extractPrNumber,
  extractRepoFlag,
  extractGitCPath,
  reconstructPrUrl,
} from './parse-command.js';

describe('stripHeredocBody', () => {
  it('returns command as-is when no heredoc present', () => {
    expect(stripHeredocBody('echo hello')).toBe('echo hello');
  });

  it('strips heredoc body after <<EOF', () => {
    const cmd = `cat <<EOF\nsome body\nmore body\nEOF`;
    expect(stripHeredocBody(cmd)).toBe('cat <<EOF');
  });

  it('handles <<-EOF variant', () => {
    const cmd = `cat <<-EOF\n\tbody\n\tEOF`;
    expect(stripHeredocBody(cmd)).toBe('cat <<-EOF');
  });

  it("handles quoted heredoc <<'EOF'", () => {
    const cmd = `cat <<'EOF'\nbody\nEOF`;
    expect(stripHeredocBody(cmd)).toBe("cat <<'EOF'");
  });

  it('returns first line if heredoc is on line 1', () => {
    const cmd = `echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'\n[]\nIMPEDIMENTS`;
    expect(stripHeredocBody(cmd)).toContain('KAIZEN_IMPEDIMENTS');
  });

  it('preserves multi-line commands before heredoc', () => {
    const cmd = `echo "hello"\necho "world"\ncat <<EOF\nbody\nEOF`;
    expect(stripHeredocBody(cmd)).toBe('echo "hello"\necho "world"\ncat <<EOF');
  });

  it('does not treat << in arithmetic as heredoc', () => {
    // Heredoc pattern requires [A-Za-z_] after <<, so "1 << 4" won't match
    expect(stripHeredocBody('echo $((1 << 4))')).toBe('echo $((1 << 4))');
  });
});

describe('isGhPrCommand', () => {
  it('detects gh pr create', () => {
    expect(isGhPrCommand('gh pr create --title "test"', 'create')).toBe(true);
  });

  it('detects gh pr merge', () => {
    expect(isGhPrCommand('gh pr merge 42 --squash', 'merge')).toBe(true);
  });

  it('detects multiple subcommands with pipe separator', () => {
    expect(isGhPrCommand('gh pr create --title "x"', 'create|merge')).toBe(
      true,
    );
    expect(isGhPrCommand('gh pr merge 42', 'create|merge')).toBe(true);
    expect(isGhPrCommand('gh pr diff', 'create|merge')).toBe(false);
  });

  it('does not false-positive on embedded text', () => {
    expect(isGhPrCommand('echo "gh pr create"', 'create')).toBe(false);
  });

  it('detects command in a chain', () => {
    expect(
      isGhPrCommand('echo done && gh pr create --title "x"', 'create'),
    ).toBe(true);
  });

  it('detects command after pipe', () => {
    expect(isGhPrCommand('echo x | gh pr diff', 'diff')).toBe(true);
  });
});

describe('isGitCommand', () => {
  it('detects git push', () => {
    expect(isGitCommand('git push', 'push')).toBe(true);
  });

  it('detects git -C <path> push', () => {
    expect(isGitCommand('git -C /some/path push', 'push')).toBe(true);
  });

  it('does not match different subcommands', () => {
    expect(isGitCommand('git pull', 'push')).toBe(false);
  });

  it('detects in a chain', () => {
    expect(isGitCommand('npm run build && git push', 'push')).toBe(true);
  });
});

describe('extractPrNumber', () => {
  it('extracts bare PR number', () => {
    expect(extractPrNumber('gh pr merge 42 --squash', 'merge')).toBe('42');
  });

  it('returns empty for no PR number', () => {
    expect(extractPrNumber('gh pr merge --squash', 'merge')).toBe('');
  });

  it('extracts from create', () => {
    expect(extractPrNumber('gh pr create 123', 'create')).toBe('123');
  });
});

describe('extractRepoFlag', () => {
  it('extracts --repo value', () => {
    expect(extractRepoFlag('gh pr merge 42 --repo Garsson-io/nanoclaw')).toBe(
      'Garsson-io/nanoclaw',
    );
  });

  it('returns empty when no --repo', () => {
    expect(extractRepoFlag('gh pr merge 42')).toBe('');
  });
});

describe('extractGitCPath', () => {
  it('extracts -C path', () => {
    expect(extractGitCPath('git -C /home/user/repo push')).toBe(
      '/home/user/repo',
    );
  });

  it('returns empty when no -C', () => {
    expect(extractGitCPath('git push')).toBe('');
  });
});

describe('reconstructPrUrl', () => {
  it('extracts URL from stdout', () => {
    expect(
      reconstructPrUrl(
        'gh pr create',
        'https://github.com/Garsson-io/nanoclaw/pull/42',
        '',
        'create',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('extracts URL from stderr', () => {
    expect(
      reconstructPrUrl(
        'gh pr create',
        '',
        'https://github.com/Garsson-io/nanoclaw/pull/42',
        'create',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('extracts URL from command args', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge https://github.com/Garsson-io/nanoclaw/pull/42',
        '',
        '',
        'merge',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('reconstructs from --repo + PR number', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge 42 --repo Garsson-io/nanoclaw',
        '',
        '',
        'merge',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('returns empty when no info available', () => {
    expect(reconstructPrUrl('gh pr create', '', '', 'create')).toBe('');
  });

  it('prefers stdout over stderr over command', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge https://github.com/A/B/pull/1',
        'https://github.com/A/B/pull/2',
        'https://github.com/A/B/pull/3',
        'merge',
      ),
    ).toBe('https://github.com/A/B/pull/2'); // stdout wins
  });
});

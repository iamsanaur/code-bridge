import { splitArgs } from './args';
import { statusGroup, timeAgo } from './format';
import { codeFromQr } from './pairing';

describe('splitArgs', () => {
  it('splits on whitespace and honours quotes, without shell semantics', () => {
    expect(splitArgs('npm run test -- --watch=false')).toEqual([
      'npm',
      'run',
      'test',
      '--',
      '--watch=false',
    ]);
    expect(splitArgs(`git commit -m "fix: a b" ''`)).toEqual([
      'git',
      'commit',
      '-m',
      'fix: a b',
      '',
    ]);
    expect(splitArgs('echo $(whoami) | cat')).toEqual(['echo', '$(whoami)', '|', 'cat']);
  });
});

describe('codeFromQr', () => {
  it('accepts codebridge pairing links only', () => {
    expect(codeFromQr('codebridge://pair?code=ABCD-EFGH&server=https%3A%2F%2Fx')).toBe('ABCDEFGH');
    expect(codeFromQr('https://evil.example/pair?code=ABCD-EFGH')).toBeNull();
    expect(codeFromQr('codebridge://pair?code=nope')).toBeNull();
    expect(codeFromQr('garbage')).toBeNull();
  });
});

describe('format helpers', () => {
  it('groups statuses for the dashboard', () => {
    expect(statusGroup('starting')).toBe('running');
    expect(statusGroup('idle')).toBe('waiting');
    expect(statusGroup('lost')).toBe('failed');
  });
  it('formats relative times', () => {
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(timeAgo(null)).toBe('never');
  });
});

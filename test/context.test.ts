// Context checkouts against a local bare repo (no network), and the ops memory repo.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ContextRepos, Memory, MemoryError } from '../src/context.ts';
import { tempDir } from './fakes.ts';

const tmp = () => tempDir('sb-ctx-');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function upstream(): { bare: string; work: string; commit: (file: string, text: string) => void } {
  const root = tmp();
  const bare = join(root, 'meta.git');
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, work);
  const commit = (file: string, text: string) => { writeFileSync(join(work, file), text); git(work, 'add', '-A'); git(work, 'commit', '-qm', file); git(work, 'push', '-q', 'origin', 'HEAD:main'); };
  commit('AGENTS.md', '# meta v1\n');
  return { bare, work, commit };
}

describe('context checkouts', () => {
  test('clone, then follow origin/main, discarding local edits', async () => {
    const up = upstream();
    const dir = tmp();
    const repos = new ContextRepos({ dir, repos: [{ name: 'team-docs', url: `file://${up.bare}`, branch: 'main' }] });
    const [first] = await repos.syncOnce();
    assert.ok(first!.head && !first!.error);
    assert.equal(readFileSync(join(dir, 'team-docs/AGENTS.md'), 'utf8'), '# meta v1\n');
    up.commit('AGENTS.md', '# meta v2\n');
    writeFileSync(join(dir, 'team-docs/AGENTS.md'), 'tampered');
    writeFileSync(join(dir, 'team-docs/stray.txt'), 'x');
    await repos.syncOnce();
    assert.equal(readFileSync(join(dir, 'team-docs/AGENTS.md'), 'utf8'), '# meta v2\n');
    assert.equal(existsSync(join(dir, 'team-docs/stray.txt')), false);
  });

  test('a failing repo reports an error and does not stop the others', async () => {
    const up = upstream();
    const repos = new ContextRepos({ dir: tmp(), repos: [{ name: 'gone', url: 'file:///nonexistent/x.git', branch: 'main' }, { name: 'ok', url: `file://${up.bare}`, branch: 'main' }] });
    const [gone, ok] = await repos.syncOnce();
    assert.ok(gone!.error);
    assert.ok(ok!.head);
  });

  test('repo names must be plain directory names', () => {
    assert.throws(() => new ContextRepos({ dir: tmp(), repos: [{ name: '../escape', url: 'x', branch: 'main' }] }), /plain directory name/);
  });
});

describe('ops memory', () => {
  test('a seed dir that doesn\'t exist fails init, naming the path, instead of seeding nothing', async () => {
    const memory = new Memory(join(tmp(), 'memory'));
    const missing = join(tmp(), 'examples/memory-seed');
    await assert.rejects(memory.init(missing), (e: unknown) => e instanceof Error && e.message.includes(missing));
    assert.equal(existsSync(join(memory.dir, '.git')), false, 'nothing half-made: the next start seeds once the path is fixed');
  });

  test('seeds, commits each edit, refuses paths outside, and reverts', async () => {
    const seed = tmp();
    mkdirSync(join(seed, 'rules'));
    writeFileSync(join(seed, 'rules/standing.md'), '# Standing rules\n');
    const memory = new Memory(join(tmp(), 'memory'));
    await memory.init(seed);
    assert.deepEqual(memory.list(), ['rules/standing.md']);
    const { sha } = await memory.propose('rules/gateway.md', 'drain first\n', 'gateway rule');
    assert.equal(memory.read('rules/gateway.md'), 'drain first\n');
    assert.match(git(memory.dir, 'log', '-1', '--format=%an %s'), /^switchboard-ops ops: gateway rule$/);
    for (const bad of ['../x.md', '/etc/passwd', 'Rules.md', 'x.txt', 'a/../../b.md']) {
      await assert.rejects(memory.propose(bad, 'x', 'y'), MemoryError, bad);
    }
    await memory.revert(sha);
    assert.deepEqual(memory.list(), ['rules/standing.md']);
  });
});

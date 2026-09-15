import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import {
  applyCandidatePatch,
  captureCandidate,
  createCandidateWorktree,
  createWorkspaceSnapshot,
  removeCandidateWorktree,
} from '../src/swarm-git.ts';

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-swarm-git-'));
  roots.push(root);
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'Test User');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'tracked.txt'), 'base\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '-m', 'base');
  return root;
}

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('swarm git isolation', () => {
  it('captures tracked, staged and untracked state without mutating the parent workspace or index', async () => {
    const repo = await makeRepo();
    const storage = await mkdtemp(join(tmpdir(), 'pi-swarm-storage-'));
    roots.push(storage);

    await writeFile(join(repo, 'tracked.txt'), 'dirty tracked\n');
    await writeFile(join(repo, 'staged.txt'), 'dirty staged\n');
    await git(repo, 'add', 'staged.txt');
    await writeFile(join(repo, 'untracked.txt'), 'dirty untracked\n');

    const headBefore = await git(repo, 'rev-parse', 'HEAD');
    const cachedBefore = await git(repo, 'diff', '--cached', '--binary');
    const worktreeBefore = await git(repo, 'diff', '--binary');
    const statusBefore = await git(repo, 'status', '--porcelain=v1');

    const snapshot = await createWorkspaceSnapshot(repo, storage);

    assert.equal(await git(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(await git(repo, 'diff', '--cached', '--binary'), cachedBefore);
    assert.equal(await git(repo, 'diff', '--binary'), worktreeBefore);
    assert.equal(await git(repo, 'status', '--porcelain=v1'), statusBefore);
    assert.equal(await git(repo, 'show', `${snapshot.commit}:tracked.txt`), 'dirty tracked');
    assert.equal(await git(repo, 'show', `${snapshot.commit}:staged.txt`), 'dirty staged');
    assert.equal(await git(repo, 'show', `${snapshot.commit}:untracked.txt`), 'dirty untracked');
  });

  it('creates isolated candidate worktrees and captures uncommitted candidate changes as a patch artifact', async () => {
    const repo = await makeRepo();
    const storage = await mkdtemp(join(tmpdir(), 'pi-swarm-storage-'));
    roots.push(storage);
    const snapshot = await createWorkspaceSnapshot(repo, storage);
    const worktree = await createCandidateWorktree(snapshot, 'c1');

    await writeFile(join(worktree.path, 'tracked.txt'), 'candidate\n');
    await writeFile(join(worktree.path, 'new.txt'), 'new candidate file\n');

    const captured = await captureCandidate(snapshot, worktree);
    assert.deepEqual(captured.changedFiles.sort(), ['new.txt', 'tracked.txt']);
    const patch = await readFile(captured.patchPath, 'utf8');
    assert.match(patch, /tracked\.txt/);
    assert.match(patch, /new\.txt/);
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'base\n');

    await removeCandidateWorktree(snapshot, worktree);
    await assert.rejects(readFile(join(worktree.path, 'tracked.txt'), 'utf8'));
  });

  it('applies a captured candidate only when the current parent can accept it cleanly', async () => {
    const repo = await makeRepo();
    const storage = await mkdtemp(join(tmpdir(), 'pi-swarm-storage-'));
    roots.push(storage);
    const snapshot = await createWorkspaceSnapshot(repo, storage);
    const worktree = await createCandidateWorktree(snapshot, 'c1');
    await writeFile(join(worktree.path, 'tracked.txt'), 'candidate\n');
    const captured = await captureCandidate(snapshot, worktree);
    await removeCandidateWorktree(snapshot, worktree);

    const applied = await applyCandidatePatch(repo, captured.patchPath);
    assert.equal(applied.applied, true);
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'candidate\n');

    await git(repo, 'reset', '--hard', 'HEAD');
    await writeFile(join(repo, 'tracked.txt'), 'conflicting parent\n');
    const conflicted = await applyCandidatePatch(repo, captured.patchPath);
    assert.equal(conflicted.applied, false);
    assert.match(conflicted.reason ?? '', /conflict|apply/i);
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'conflicting parent\n');
  });
});

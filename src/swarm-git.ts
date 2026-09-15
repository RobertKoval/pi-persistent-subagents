import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface WorkspaceSnapshot {
  repoRoot: string;
  parentCwd: string;
  head: string;
  commit: string;
  rootDir: string;
  worktreesDir: string;
  artifactsDir: string;
}

export interface CandidateWorktree {
  id: string;
  path: string;
}

export interface CapturedCandidate {
  candidateId: string;
  commit: string;
  patchPath: string;
  changedFiles: string[];
}

export interface ApplyCandidateResult {
  applied: boolean;
  reason?: string;
}

const SNAPSHOT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Pi Local Swarm',
  GIT_AUTHOR_EMAIL: 'pi-local-swarm@example.invalid',
  GIT_COMMITTER_NAME: 'Pi Local Swarm',
  GIT_COMMITTER_EMAIL: 'pi-local-swarm@example.invalid',
};

export async function createWorkspaceSnapshot(cwd: string, storageRoot: string): Promise<WorkspaceSnapshot> {
  const parentCwd = resolve(cwd);
  const repoRoot = await git(parentCwd, ['rev-parse', '--show-toplevel']);
  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const rootDir = await mkdtemp(join(storageRoot, 'swarm-'));
  const worktreesDir = join(rootDir, 'worktrees');
  const artifactsDir = join(rootDir, 'artifacts');
  await Promise.all([
    mkdir(worktreesDir, { recursive: true, mode: 0o700 }),
    mkdir(artifactsDir, { recursive: true, mode: 0o700 }),
  ]);

  const indexPath = join(rootDir, 'snapshot.index');
  const env = gitIndexEnv(indexPath);
  try {
    await git(repoRoot, ['read-tree', head], env);
    await git(repoRoot, ['add', '-A'], env);
    const tree = await git(repoRoot, ['write-tree'], env);
    const commit = await git(repoRoot, ['commit-tree', tree, '-p', head, '-m', 'pi local swarm workspace snapshot'], {
      ...env,
      ...SNAPSHOT_IDENTITY,
    });
    return { repoRoot, parentCwd, head, commit, rootDir, worktreesDir, artifactsDir };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

export async function createCandidateWorktree(
  snapshot: WorkspaceSnapshot,
  candidateId: string,
): Promise<CandidateWorktree> {
  const id = safeId(candidateId);
  const path = join(snapshot.worktreesDir, id);
  await git(snapshot.repoRoot, ['worktree', 'add', '--detach', path, snapshot.commit]);
  return { id, path };
}

export async function captureCandidate(
  snapshot: WorkspaceSnapshot,
  worktree: CandidateWorktree,
): Promise<CapturedCandidate> {
  const artifactDir = join(snapshot.artifactsDir, safeId(worktree.id));
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const indexPath = join(artifactDir, 'candidate.index');
  const env = gitIndexEnv(indexPath);
  try {
    await git(worktree.path, ['read-tree', snapshot.commit], env);
    await git(worktree.path, ['add', '-A'], env);
    const tree = await git(worktree.path, ['write-tree'], env);
    const commit = await git(worktree.path, ['commit-tree', tree, '-p', snapshot.commit, '-m', `pi local swarm candidate ${worktree.id}`], {
      ...env,
      ...SNAPSHOT_IDENTITY,
    });
    const patch = await git(worktree.path, ['diff', '--binary', '--full-index', snapshot.commit, commit], undefined, false);
    const names = await git(worktree.path, ['diff', '--name-only', '--no-renames', snapshot.commit, commit], undefined, false);
    const changedFiles = names.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const patchPath = join(artifactDir, 'patch.diff');
    await writeFile(patchPath, patch, { encoding: 'utf8', mode: 0o600 });
    return { candidateId: worktree.id, commit, patchPath, changedFiles };
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

export async function removeCandidateWorktree(
  snapshot: WorkspaceSnapshot,
  worktree: CandidateWorktree,
): Promise<void> {
  try {
    await git(snapshot.repoRoot, ['worktree', 'remove', '--force', worktree.path]);
  } catch {
    await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
    await git(snapshot.repoRoot, ['worktree', 'prune']).catch(() => undefined);
  }
}

export async function applyCandidatePatch(parentCwd: string, patchPath: string): Promise<ApplyCandidateResult> {
  const patch = await readFile(patchPath, 'utf8');
  if (!patch.trim()) return { applied: false, reason: 'Candidate patch is empty' };
  const repoRoot = await git(resolve(parentCwd), ['rev-parse', '--show-toplevel']);
  try {
    await git(repoRoot, ['apply', '--check', '--binary', patchPath]);
  } catch (error) {
    return { applied: false, reason: `Patch cannot apply cleanly: ${errorMessage(error)}` };
  }
  try {
    await git(repoRoot, ['apply', '--binary', patchPath]);
    return { applied: true };
  } catch (error) {
    return { applied: false, reason: `Patch apply failed: ${errorMessage(error)}` };
  }
}

export async function removeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
  await git(snapshot.repoRoot, ['worktree', 'prune']).catch(() => undefined);
  await rm(snapshot.rootDir, { recursive: true, force: true });
}

function gitIndexEnv(indexPath: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_INDEX_FILE: indexPath };
}

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  trim = true,
): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, {
      cwd,
      env: env ?? process.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return trim ? stdout.trim() : stdout;
  } catch (error) {
    const stderr = typeof (error as any)?.stderr === 'string' ? (error as any).stderr.trim() : '';
    const detail = stderr || errorMessage(error);
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`);
  }
}

function safeId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe swarm candidate id: ${value}`);
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

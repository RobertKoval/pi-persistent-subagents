import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** Parent's expectation of whether a worker will be reused; steers Pi's idle cache warming in the worker. */
export const REUSE_POLICIES = ['one_shot', 'likely_soon', 'long_lived'] as const;
export type ReusePolicy = (typeof REUSE_POLICIES)[number];
/** Provider prompt-cache retention for a worker's requests (Pi's PI_CACHE_RETENTION). */
export const CACHE_RETENTIONS = ['default', 'long'] as const;
export type CacheRetention = (typeof CACHE_RETENTIONS)[number];
/** Below this a compacted worker would immediately exceed its budget again (Pi keeps ~20k recent tokens). */
export const MIN_CONTEXT_BUDGET_TOKENS = 32_768;
export const MAX_CONTEXT_BUDGET_TOKENS = 10_000_000;

export interface WorkerPolicy {
  contextBudgetTokens?: number;
  reuse?: ReusePolicy;
  cacheRetention?: CacheRetention;
}

export interface RoleConfig extends WorkerPolicy {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevelName;
  description?: string;
  /** Extra Pi extensions (-e) for workers of this role. Global config only: they run host code. */
  extensions?: string[];
}

export interface PersistentSubagentConfig extends WorkerPolicy {
  metricsWorkers: boolean;
  metricsMain: boolean;
  maxAgents: number;
  maxDepth: number;
  idleTtlMs: number;
  startupTimeoutMs: number;
  commandTimeoutMs: number;
  shutdownGraceMs: number;
  compactionTimeoutMs: number;
  /** Extra Pi extensions (-e) for every worker. Global config only: they run host code. */
  workerExtensions: string[];
  notifyOnSettled: boolean;
  notificationMaxChars: number;
  inheritParentProvider: boolean;
  inheritParentModel: boolean;
  inheritParentThinking: boolean;
  roles: Record<string, RoleConfig>;
}

export const DEFAULT_CONFIG: PersistentSubagentConfig = {
  metricsWorkers: true,
  metricsMain: false,
  maxAgents: 6,
  maxDepth: 1,
  idleTtlMs: 0,
  startupTimeoutMs: 15_000,
  commandTimeoutMs: 30_000,
  // Pi finishes shutdown work such as an OAuth refresh before exiting; SIGKILL is only the last resort.
  shutdownGraceMs: 10_000,
  compactionTimeoutMs: 600_000,
  workerExtensions: [],
  notifyOnSettled: true,
  notificationMaxChars: 4_000,
  inheritParentProvider: true,
  inheritParentModel: false,
  inheritParentThinking: true,
  roles: {},
};

export interface LoadedConfig {
  config: PersistentSubagentConfig;
  warnings: string[];
}

type PartialConfig = Partial<Omit<PersistentSubagentConfig, 'roles'>> & { roles?: Record<string, RoleConfig> };
type ConfigSource = 'global' | 'project';

const TOP_LEVEL_KEYS = new Set<keyof PersistentSubagentConfig>([
  'metricsWorkers', 'metricsMain', 'maxAgents', 'maxDepth', 'idleTtlMs', 'startupTimeoutMs', 'commandTimeoutMs', 'shutdownGraceMs',
  'compactionTimeoutMs', 'workerExtensions', 'notifyOnSettled', 'notificationMaxChars', 'inheritParentProvider', 'inheritParentModel',
  'inheritParentThinking', 'contextBudgetTokens', 'reuse', 'cacheRetention', 'roles',
]);
const ROLE_KEYS = new Set<keyof RoleConfig>([
  'provider', 'model', 'thinking', 'description', 'extensions', 'contextBudgetTokens', 'reuse', 'cacheRetention',
]);

export interface ConfigTrust {
  /** Pi's ctx.isProjectTrusted(): project-local .pi configuration counts only in a trusted project. */
  projectTrusted: boolean;
}

export async function loadConfig(cwd: string, agentDir: string, trust: ConfigTrust): Promise<LoadedConfig> {
  const warnings: string[] = [];
  let config = cloneConfig(DEFAULT_CONFIG);
  const globalPath = join(agentDir, 'persistent-subagents', 'config.json');
  const projectPath = join(cwd, '.pi', 'persistent-subagents.json');

  const global = await readConfigFile(globalPath, 'global', warnings);
  if (global) config = mergeConfig(config, global);
  if (trust.projectTrusted) {
    const project = await readConfigFile(projectPath, 'project', warnings);
    if (project) config = mergeConfig(config, project);
  } else if (await exists(projectPath)) {
    // Same rule as Pi's own .pi settings: a cloned repository must not configure workers before it is trusted.
    warnings.push(`project config ${projectPath} is ignored because Pi does not trust this project (trust it, or start Pi with --approve)`);
  }

  return { config, warnings };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function cloneConfig(config: PersistentSubagentConfig): PersistentSubagentConfig {
  return {
    ...config,
    workerExtensions: [...config.workerExtensions],
    roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, { ...role, ...(role.extensions ? { extensions: [...role.extensions] } : {}) }])),
  };
}

async function readConfigFile(path: string, label: ConfigSource, warnings: string[]): Promise<PartialConfig | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    warnings.push(`${label} config ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  try {
    const raw: unknown = JSON.parse(text);
    return validatePartialConfig(raw, label);
  } catch (error) {
    warnings.push(`${label} config ${path} is invalid and was ignored: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validatePartialConfig(raw: unknown, source: ConfigSource): PartialConfig {
  if (!isPlainObject(raw)) throw new Error('configuration must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key as keyof PersistentSubagentConfig)) throw new Error(`unknown field "${key}"`);
  }

  const result: PartialConfig = {};
  if ('metricsWorkers' in raw) result.metricsWorkers = booleanValue(raw.metricsWorkers, 'metricsWorkers');
  if ('metricsMain' in raw) result.metricsMain = booleanValue(raw.metricsMain, 'metricsMain');
  if ('maxAgents' in raw) result.maxAgents = integerInRange(raw.maxAgents, 'maxAgents', 1, 64);
  if ('maxDepth' in raw) result.maxDepth = integerInRange(raw.maxDepth, 'maxDepth', 0, 16);
  if ('idleTtlMs' in raw) result.idleTtlMs = integerInRange(raw.idleTtlMs, 'idleTtlMs', 0, 86_400_000);
  if ('startupTimeoutMs' in raw) result.startupTimeoutMs = integerInRange(raw.startupTimeoutMs, 'startupTimeoutMs', 100, 300_000);
  if ('commandTimeoutMs' in raw) result.commandTimeoutMs = integerInRange(raw.commandTimeoutMs, 'commandTimeoutMs', 100, 3_600_000);
  if ('shutdownGraceMs' in raw) result.shutdownGraceMs = integerInRange(raw.shutdownGraceMs, 'shutdownGraceMs', 0, 60_000);
  if ('compactionTimeoutMs' in raw) result.compactionTimeoutMs = integerInRange(raw.compactionTimeoutMs, 'compactionTimeoutMs', 1_000, 3_600_000);
  if ('workerExtensions' in raw) result.workerExtensions = extensionList(raw.workerExtensions, 'workerExtensions', source);
  Object.assign(result, workerPolicy(raw, ''));
  if ('notificationMaxChars' in raw) result.notificationMaxChars = integerInRange(raw.notificationMaxChars, 'notificationMaxChars', 256, 100_000);
  if ('notifyOnSettled' in raw) result.notifyOnSettled = booleanValue(raw.notifyOnSettled, 'notifyOnSettled');
  if ('inheritParentProvider' in raw) result.inheritParentProvider = booleanValue(raw.inheritParentProvider, 'inheritParentProvider');
  if ('inheritParentModel' in raw) result.inheritParentModel = booleanValue(raw.inheritParentModel, 'inheritParentModel');
  if ('inheritParentThinking' in raw) result.inheritParentThinking = booleanValue(raw.inheritParentThinking, 'inheritParentThinking');

  if ('roles' in raw) {
    if (!isPlainObject(raw.roles)) throw new Error('roles must be an object');
    const roles: Record<string, RoleConfig> = {};
    for (const [name, value] of Object.entries(raw.roles)) {
      if (!name.trim()) throw new Error('role names must be non-empty');
      if (!isPlainObject(value)) throw new Error(`role "${name}" must be an object`);
      for (const key of Object.keys(value)) {
        if (!ROLE_KEYS.has(key as keyof RoleConfig)) throw new Error(`unknown field "roles.${name}.${key}"`);
      }
      const role: RoleConfig = workerPolicy(value, `roles.${name}.`);
      if ('provider' in value) role.provider = nonEmptyString(value.provider, `roles.${name}.provider`);
      if ('description' in value) role.description = nonEmptyString(value.description, `roles.${name}.description`);
      if ('extensions' in value) role.extensions = extensionList(value.extensions, `roles.${name}.extensions`, source);
      if ('model' in value) role.model = nonEmptyString(value.model, `roles.${name}.model`);
      if ('thinking' in value) {
        const level = nonEmptyString(value.thinking, `roles.${name}.thinking`);
        if (!THINKING_LEVELS.includes(level as ThinkingLevelName)) throw new Error(`invalid thinking level "${level}" for role "${name}"`);
        role.thinking = level as ThinkingLevelName;
      }
      roles[name] = role;
    }
    result.roles = roles;
  }

  return result;
}

function mergeConfig(base: PersistentSubagentConfig, patch: PartialConfig): PersistentSubagentConfig {
  const mergedRoles: Record<string, RoleConfig> = { ...base.roles };
  if (patch.roles) {
    for (const [name, role] of Object.entries(patch.roles)) mergedRoles[name] = { ...(base.roles[name] ?? {}), ...role };
  }
  return { ...base, ...patch, roles: mergedRoles } as PersistentSubagentConfig;
}

function workerPolicy(raw: Record<string, unknown>, prefix: string): WorkerPolicy {
  const policy: WorkerPolicy = {};
  if ('contextBudgetTokens' in raw) {
    policy.contextBudgetTokens = integerInRange(raw.contextBudgetTokens, `${prefix}contextBudgetTokens`, MIN_CONTEXT_BUDGET_TOKENS, MAX_CONTEXT_BUDGET_TOKENS);
  }
  if ('reuse' in raw) policy.reuse = oneOf(raw.reuse, `${prefix}reuse`, REUSE_POLICIES);
  if ('cacheRetention' in raw) policy.cacheRetention = oneOf(raw.cacheRetention, `${prefix}cacheRetention`, CACHE_RETENTIONS);
  return policy;
}

function extensionList(value: unknown, name: string, source: ConfigSource): string[] {
  // A project file is repository content; letting it name code for workers to load would bypass Pi's project trust.
  if (source !== 'global') throw new Error(`${name} may only be set in the global config, because workers load and run those extensions`);
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of extension paths`);
  return value.map((entry, index) => {
    const path = nonEmptyString(entry, `${name}[${index}]`);
    if (!isAbsolute(path) && !/^builtin:[a-z0-9.-]+$/i.test(path)) {
      throw new Error(`${name}[${index}] must be an absolute path or builtin:<name>, got "${path}"`);
    }
    return path;
  });
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function integerInRange(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

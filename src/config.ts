import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface RoleConfig {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevelName;
}

export interface PersistentSubagentConfig {
  maxAgents: number;
  maxDepth: number;
  idleTtlMs: number;
  startupTimeoutMs: number;
  commandTimeoutMs: number;
  shutdownGraceMs: number;
  notifyOnSettled: boolean;
  notificationMaxChars: number;
  inheritParentProvider: boolean;
  inheritParentModel: boolean;
  inheritParentThinking: boolean;
  roles: Record<string, RoleConfig>;
}

export const DEFAULT_CONFIG: PersistentSubagentConfig = {
  maxAgents: 6,
  maxDepth: 1,
  idleTtlMs: 0,
  startupTimeoutMs: 15_000,
  commandTimeoutMs: 30_000,
  shutdownGraceMs: 1_500,
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

const TOP_LEVEL_KEYS = new Set<keyof PersistentSubagentConfig>([
  'maxAgents', 'maxDepth', 'idleTtlMs', 'startupTimeoutMs', 'commandTimeoutMs', 'shutdownGraceMs',
  'notifyOnSettled', 'notificationMaxChars', 'inheritParentProvider', 'inheritParentModel',
  'inheritParentThinking', 'roles',
]);
const ROLE_KEYS = new Set<keyof RoleConfig>(['provider', 'model', 'thinking']);

export async function loadConfig(cwd: string, agentDir: string): Promise<LoadedConfig> {
  const warnings: string[] = [];
  let config = cloneConfig(DEFAULT_CONFIG);
  const globalPath = join(agentDir, 'persistent-subagents', 'config.json');
  const projectPath = join(cwd, '.pi', 'persistent-subagents.json');

  const global = await readConfigFile(globalPath, 'global', warnings);
  if (global) config = mergeConfig(config, global);
  const project = await readConfigFile(projectPath, 'project', warnings);
  if (project) config = mergeConfig(config, project);

  return { config, warnings };
}

function cloneConfig(config: PersistentSubagentConfig): PersistentSubagentConfig {
  return { ...config, roles: Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, { ...role }])) };
}

async function readConfigFile(path: string, label: string, warnings: string[]): Promise<PartialConfig | null> {
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
    return validatePartialConfig(raw);
  } catch (error) {
    warnings.push(`${label} config ${path} is invalid and was ignored: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validatePartialConfig(raw: unknown): PartialConfig {
  if (!isPlainObject(raw)) throw new Error('configuration must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key as keyof PersistentSubagentConfig)) throw new Error(`unknown field "${key}"`);
  }

  const result: PartialConfig = {};
  if ('maxAgents' in raw) result.maxAgents = integerInRange(raw.maxAgents, 'maxAgents', 1, 64);
  if ('maxDepth' in raw) result.maxDepth = integerInRange(raw.maxDepth, 'maxDepth', 0, 16);
  if ('idleTtlMs' in raw) result.idleTtlMs = integerInRange(raw.idleTtlMs, 'idleTtlMs', 0, 86_400_000);
  if ('startupTimeoutMs' in raw) result.startupTimeoutMs = integerInRange(raw.startupTimeoutMs, 'startupTimeoutMs', 100, 300_000);
  if ('commandTimeoutMs' in raw) result.commandTimeoutMs = integerInRange(raw.commandTimeoutMs, 'commandTimeoutMs', 100, 3_600_000);
  if ('shutdownGraceMs' in raw) result.shutdownGraceMs = integerInRange(raw.shutdownGraceMs, 'shutdownGraceMs', 0, 60_000);
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
      const role: RoleConfig = {};
      if ('provider' in value) role.provider = nonEmptyString(value.provider, `roles.${name}.provider`);
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

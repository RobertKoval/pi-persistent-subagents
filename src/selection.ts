import type { PersistentSubagentConfig, RoleConfig, ThinkingLevelName } from './config.ts';

export interface WorkerSelectionInput {
  role?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevelName;
  cwd?: string;
}

export interface ParentSelection {
  provider?: string;
  model?: string;
  thinking?: string;
  cwd: string;
}

export interface ResolvedWorkerSelection {
  provider?: string;
  model?: string;
  thinking?: string;
  cwd: string;
}

export function resolveWorkerSelection(
  input: WorkerSelectionInput,
  parent: ParentSelection,
  config: PersistentSubagentConfig,
  role: RoleConfig | undefined,
): ResolvedWorkerSelection {
  const explicitModel = parseModelRef(input.model);
  const roleModel = parseModelRef(role?.model);

  const provider = clean(input.provider)
    ?? explicitModel.provider
    ?? clean(role?.provider)
    ?? roleModel.provider
    ?? (config.inheritParentProvider ? clean(parent.provider) : undefined);

  const model = explicitModel.model
    ?? roleModel.model
    ?? (config.inheritParentModel ? clean(parent.model) : undefined);

  const thinking = clean(input.thinking)
    ?? clean(role?.thinking)
    ?? (config.inheritParentThinking ? clean(parent.thinking) : undefined);

  return {
    provider,
    model,
    thinking,
    cwd: clean(input.cwd) ?? parent.cwd,
  };
}

function parseModelRef(value: string | undefined): { provider?: string; model?: string } {
  const normalized = clean(value);
  if (!normalized) return {};
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) return { model: normalized };
  return { provider: normalized.slice(0, slash), model: normalized.slice(slash + 1) };
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

import type { PersistentSubagentConfig, RoleConfig, ThinkingLevelName } from './config.ts';

export interface WorkerSelectionInput {
  role?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevelName;
  cwd?: string;
}

export interface ParentSelection {
  models?: readonly {provider: string; id: string}[];
  provider?: string;
  model?: string;
  thinking?: string;
  cwd: string;
  /** Pi's configured startup selection (settings defaultProvider/defaultModel). */
  defaults?: {provider?: string; model?: string};
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
  const inheritedProvider = config.inheritParentProvider ? clean(parent.provider) : undefined;
  const roleModel = parseModelRef(role?.model, clean(role?.provider), inheritedProvider, parent.models);
  const explicitModel = parseModelRef(input.model, clean(input.provider), clean(role?.provider) ?? roleModel.provider ?? inheritedProvider, parent.models);

  const provider = clean(input.provider)
    ?? explicitModel.provider
    ?? clean(role?.provider)
    ?? roleModel.provider
    ?? (config.inheritParentProvider ? clean(parent.provider) : undefined);

  const model = explicitModel.model
    ?? roleModel.model
    ?? (config.inheritParentModel ? clean(parent.model) : undefined)
    ?? (provider ? providerDefaultModel(provider, parent) : undefined);
  // Pi 1.x rejects --provider without --model, so an unresolved pair must fail here, with a remedy.
  if (provider && !model) {
    throw new Error(`Worker provider "${provider}" has no model: Pi requires one. Pass model, configure a role with a model, or set inheritParentModel.`);
  }

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

/** The model Pi would start with for this provider: the configured default, else the parent's own model. */
function providerDefaultModel(provider: string, parent: ParentSelection): string | undefined {
  if (clean(parent.defaults?.provider) === provider && clean(parent.defaults?.model)) return clean(parent.defaults?.model);
  if (clean(parent.provider) === provider) return clean(parent.model);
  return undefined;
}

function parseModelRef(
  value: string | undefined,
  provider?: string,
  inheritedProvider?: string,
  models: ParentSelection['models'] = [],
): { provider?: string; model?: string } {
  const normalized = clean(value);
  if (!normalized) return {};
  const selectedProvider = provider ?? inheritedProvider;
  const known = (id: string) => models.some(m => m.provider === selectedProvider && m.id === id);
  if (known(normalized)) return {model: normalized};
  if (provider) {
    const prefix = `${provider}/`;
    const suffix = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
    // Strip a redundant prefix only when its meaning is established.
    if (suffix && (known(suffix) || suffix.startsWith('@preset/'))) return {model:suffix};
    return {model: normalized};
  }
  if (normalized.startsWith('@')) return { model: normalized };
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) return { model: normalized };
  const prefix = normalized.slice(0, slash);
  if (models.length && !models.some(m => m.provider === prefix)) return {model: normalized};
  return { provider: prefix, model: normalized.slice(slash + 1) };
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

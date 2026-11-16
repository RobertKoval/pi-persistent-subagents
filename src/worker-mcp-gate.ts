import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Worker MCP allowlist: per MCP server, the tool-name patterns a worker may call.
 * Every other tool of a listed server is blocked in workers; unlisted servers are untouched.
 *
 * The root session's allowlist travels to every worker generation in this environment variable,
 * and each worker loads this file explicitly with `-e`, so enforcement does not depend on the
 * child discovering the extension package.
 */
export const WORKER_MCP_ALLOWLIST_ENV = 'PI_PERSISTENT_WORKER_MCP_ALLOWLIST';
export const WORKER_MCP_GATE_PATH = fileURLToPath(import.meta.url);

export type WorkerMcpAllowlist = Readonly<Record<string, readonly string[]>>;

export type ToolVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

interface ServerRule {
  readonly server: string;
  /** Pi's tool-name prefix for the server: `mcp__<server>__` with non-word characters replaced by `_`. */
  readonly prefix: string;
  readonly patterns: readonly RegExp[];
  readonly allowed: readonly string[];
}

export type WorkerGatePolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'allowlist'; readonly rules: readonly ServerRule[] }
  | { readonly kind: 'invalid'; readonly error: string };

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ALLOWED: ToolVerdict = { allowed: true };

/** Validates a configured allowlist; throws with the offending field on invalid input. */
export function validateWorkerMcpAllowlist(raw: unknown, name = 'workerMcpAllowlist'): WorkerMcpAllowlist {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name} must be an object`);
  const result: Record<string, string[]> = {};
  const seen = new Map<string, string>();
  for (const [server, patterns] of Object.entries(raw)) {
    if (!SERVER_NAME.test(server)) throw new Error(`${name} server "${server}" may contain only letters, digits, "_" and "-"`);
    const same = seen.get(piName(server));
    if (same !== undefined) throw new Error(`${name} servers "${same}" and "${server}" name the same Pi server`);
    seen.set(piName(server), server);
    if (!Array.isArray(patterns)) throw new Error(`${name}.${server} must be an array of tool name patterns`);
    result[server] = patterns.map((pattern, index) => {
      if (typeof pattern !== 'string' || !pattern.trim()) throw new Error(`${name}.${server}[${index}] must be a non-empty string`);
      return pattern.trim();
    });
  }
  return result;
}

/** A patch entry replaces the base entry for the same Pi server, however its name is spelled. */
export function mergeWorkerMcpAllowlists(base: WorkerMcpAllowlist, patch: WorkerMcpAllowlist): WorkerMcpAllowlist {
  const patched = new Set(Object.keys(patch).map(piName));
  return { ...Object.fromEntries(Object.entries(base).filter(([server]) => !patched.has(piName(server)))), ...patch };
}

export function compileWorkerMcpAllowlist(allowlist: WorkerMcpAllowlist): WorkerGatePolicy {
  const rules = Object.entries(allowlist).map(([server, allowed]): ServerRule => ({
    server,
    prefix: `mcp__${piName(server)}__`,
    patterns: allowed.map(patternRegExp),
    allowed,
  }));
  return rules.length ? { kind: 'allowlist', rules } : { kind: 'none' };
}

/**
 * The allowlist this session hands to its workers: the one it inherited, unchanged, or else its own
 * configuration. A worker's configuration therefore cannot loosen what the root session decided.
 */
export function workerAllowlistForChildren(inherited: string | undefined, configured: WorkerMcpAllowlist): string | undefined {
  if (inherited !== undefined) return inherited;
  return Object.keys(configured).length ? JSON.stringify(configured) : undefined;
}

/** Reads the inherited policy. A present but unreadable value fails closed for every MCP tool. */
export function policyFromEnv(raw: string | undefined): WorkerGatePolicy {
  if (raw === undefined) return { kind: 'none' };
  try {
    return compileWorkerMcpAllowlist(validateWorkerMcpAllowlist(JSON.parse(raw), WORKER_MCP_ALLOWLIST_ENV));
  } catch (error) {
    return { kind: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A tool name can fit several configured servers when server names contain `__`
 * (`mcp__a__b__c` is server `a` tool `b__c`, or server `a__b` tool `c`).
 * The call is allowed only if every matching server's allowlist accepts it.
 */
export function decideWorkerToolCall(policy: WorkerGatePolicy, toolName: string): ToolVerdict {
  switch (policy.kind) {
    case 'none':
      return ALLOWED;
    case 'invalid':
      return toolName.startsWith('mcp__')
        ? { allowed: false, reason: `persistent-subagents: ${toolName} is blocked because the worker MCP allowlist is invalid (${policy.error}).` }
        : ALLOWED;
    case 'allowlist':
      for (const rule of policy.rules) {
        if (!toolName.startsWith(rule.prefix)) continue;
        const tool = toolName.slice(rule.prefix.length);
        if (rule.patterns.some((pattern) => pattern.test(tool))) continue;
        const limit = rule.allowed.length ? `limited to ${rule.allowed.join(', ')}` : 'closed';
        return {
          allowed: false,
          reason: `persistent-subagents: ${toolName} is not available to workers; MCP server "${rule.server}" is ${limit} for workers. Return what you found to the parent agent instead.`,
        };
      }
      return ALLOWED;
  }
}

/** Pi's MCP naming: every character other than letters, digits and `_` becomes `_`. */
function piName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/** `*` matches any characters; the rest follows Pi's naming, so `get-page` and `get_page` are the same tool. */
function patternRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[^A-Za-z0-9_*]/g, '_').replaceAll('*', '.*')}$`);
}

export default function workerMcpGate(pi: ExtensionAPI): void {
  const policy = policyFromEnv(process.env[WORKER_MCP_ALLOWLIST_ENV]);
  if (policy.kind === 'none') return;
  pi.on('tool_call', (event) => {
    const verdict = decideWorkerToolCall(policy, event.toolName);
    return verdict.allowed ? undefined : { block: true, reason: verdict.reason };
  });
}

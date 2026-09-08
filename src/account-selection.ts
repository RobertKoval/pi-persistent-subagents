import { existsSync, writeFileSync } from 'node:fs';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';

// pi-accounts 0.51 session contract. Only named selections cross this boundary;
// credential loading and refresh remain owned by the installed accounts extension.
export function seedAccountSelection(path: string, cwd: string, parent: ExtensionContext['sessionManager']): void {
  if (existsSync(path)) return; // Resume preserves the worker's original selection.
  const entry = [...parent.getEntries()].reverse().find(e =>
    e.type === 'custom' && e.customType === 'pi-accounts-selection' &&
    (e.data as { sessionId?: unknown } | null)?.sessionId === parent.getSessionId());
  if (!entry || entry.type !== 'custom') return;
  const data = entry.data as { version?: unknown; providers?: unknown };
  if (data.version !== 1 || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) {
    throw new Error('Invalid parent pi-accounts selection; refusing to use a different account');
  }
  const providers: Record<string, string | null> = Object.create(null);
  for (const [provider, account] of Object.entries(data.providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) ||
        (account !== null && (typeof account !== 'string' || !account.trim()))) {
      throw new Error('Invalid parent pi-accounts selection');
    }
    providers[provider] = account;
  }
  const session = SessionManager.open(path, undefined, cwd);
  session.appendCustomEntry('pi-accounts-selection', {
    version: 1, sessionId: session.getSessionId(), providers,
  });
  // Pi delays disk writes until an assistant turn. Persist this credential-free
  // initial session so accounts can restore it before the first model request.
  writeFileSync(path, [session.getHeader(), ...session.getEntries()].map(e => JSON.stringify(e)).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
}

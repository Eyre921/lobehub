import { type LobeChatDatabase } from '@lobechat/database';
import { and, eq } from 'drizzle-orm';

import { AiProviderModel } from '@/database/models/aiProvider';
import { account, users } from '@/database/schemas';
import { getLLMConfig } from '@/envs/llm';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';

/**
 * Server-side client of new-api's `/api/provision` surface.
 *
 * LobeHub delegates model billing to a self-hosted new-api gateway: every user
 * gets exactly one managed relay token there (named {@link MANAGED_TOKEN_NAME}),
 * keyed by the user's Logto subject (`accounts.accountId` here,
 * `users.oidc_id` on the gateway). This service provisions that token lazily,
 * stores it encrypted in `ai_providers.key_vaults`, rebinds its billing group,
 * and reads balance/usable-group data for the account panel.
 *
 * The credential (`NEWAPI_PROVISION_KEY`) is server-only and deliberately
 * narrow: it can mint/rebind per-user tokens and read balances, but cannot
 * top up quota or touch gateway administration.
 */

export const MANAGED_TOKEN_NAME = 'lobehub';

const LOGTO_PROVIDER_ID = 'logto';
const PROVIDER_ID = 'newapi';
const REQUEST_TIMEOUT = 10_000;
const ACCOUNT_CACHE_TTL = 30_000;

export interface GatewayUsableGroup {
  desc: string;
  ratio: number | 'auto';
  sort: number;
}

export interface GatewayAccount {
  displayName: string;
  group: string;
  quota: number;
  quotaPerUnit: number;
  status: number;
  usableGroups: Record<string, GatewayUsableGroup>;
  usedQuota: number;
  userId: number;
  username: string;
}

export class NewApiUnboundError extends Error {
  constructor(message = 'new-api account is not linked to this Logto identity') {
    super(message);
    this.name = 'NewApiUnboundError';
  }
}

interface GatewayEnvConfig {
  autoProvision: boolean;
  dataBaseURL: string;
  key: string;
  provisionBaseURL: string;
}

const getGatewayEnv = (): GatewayEnvConfig => {
  const config = getLLMConfig();
  const dataBaseURL = (config.NEWAPI_PROXY_URL || '').replace(/\/+$/, '');
  // provision endpoints live at the gateway origin — strip an /v1-style
  // suffix that operators commonly keep on NEWAPI_PROXY_URL
  const provisionBaseURL = (config.NEWAPI_PROVISION_URL || dataBaseURL)
    .replace(/\/v\d+[a-z]*\/?$/, '')
    .replace(/\/+$/, '');

  return {
    autoProvision: config.NEWAPI_AUTO_PROVISION,
    dataBaseURL,
    key: config.NEWAPI_PROVISION_KEY || '',
    provisionBaseURL,
  };
};

export const isNewApiGatewayEnabled = () => {
  const { key, provisionBaseURL } = getGatewayEnv();
  return !!key && !!provisionBaseURL;
};

interface GatewayResponse<T> {
  data?: T;
  message?: string;
  success: boolean;
}

// process-wide single-flight so concurrent first messages provision once
const inflightProvision = new Map<string, Promise<{ apiKey: string; baseURL: string }>>();
const accountCache = new Map<string, { data: GatewayAccount | null; expires: number }>();

export class NewApiGatewayService {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  /**
   * Resolve the user's Logto subject — the cross-system account anchor.
   */
  getLogtoSub = async (userId: string): Promise<string | null> => {
    const logtoAccount = await this.db.query.account.findFirst({
      where: and(eq(account.userId, userId), eq(account.providerId, LOGTO_PROVIDER_ID)),
    });

    return logtoAccount?.accountId ?? null;
  };

  /**
   * Fetch the bound gateway account; null means the sub is not bound yet
   * (the gateway answers 404 for that case specifically).
   */
  fetchAccount = async (sub: string, skipCache = false): Promise<GatewayAccount | null> => {
    if (!skipCache) {
      const cached = accountCache.get(sub);
      if (cached && cached.expires > Date.now()) return cached.data;
    }

    const res = await this.request<any>('GET', `/api/provision/user/${encodeURIComponent(sub)}`);
    const data = res.status === 404 ? null : this.mapAccount(res.body?.data, res);
    accountCache.set(sub, { data, expires: Date.now() + ACCOUNT_CACHE_TTL });
    return data;
  };

  /**
   * Ensure the managed relay token exists and persist it (encrypted) into the
   * user's newapi keyVaults. Idempotent and single-flighted per user.
   */
  ensureUserApiKey = (userId: string): Promise<{ apiKey: string; baseURL: string }> => {
    const inflight = inflightProvision.get(userId);
    if (inflight) return inflight;

    const task = this.provisionUserApiKey(userId).finally(() => {
      inflightProvision.delete(userId);
    });
    inflightProvision.set(userId, task);
    return task;
  };

  /**
   * Drop the stored key and mint/fetch a fresh one — the self-heal path when
   * the gateway rejects the stored key (user deleted the token on the
   * gateway dashboard, admin rotated it, ...).
   */
  refreshUserApiKey = async (userId: string) => {
    accountCache.clear();
    await this.persistKeyVaults(userId, { apiKey: '' });
    return this.ensureUserApiKey(userId);
  };

  /**
   * Rebind the managed token's billing group (key stays the same). If the
   * token disappeared on the gateway side, re-provision and retry once.
   */
  rebindGroup = async (userId: string, group: string): Promise<string> => {
    const sub = await this.requireSub(userId);

    let res = await this.request('PUT', '/api/provision/token/group', {
      group,
      name: MANAGED_TOKEN_NAME,
      sub,
    });
    if (res.status === 404) {
      await this.ensureUserApiKey(userId);
      res = await this.request('PUT', '/api/provision/token/group', {
        group,
        name: MANAGED_TOKEN_NAME,
        sub,
      });
    }
    if (!res.body?.success) {
      throw new Error(res.body?.message || `gateway rejected group rebind (status ${res.status})`);
    }
    accountCache.delete(sub);
    return (res.body.data as any)?.group ?? group;
  };

  /**
   * Aggregated state for the provider settings panel.
   */
  getAccountOverview = async (userId: string) => {
    const { dataBaseURL, provisionBaseURL, autoProvision } = getGatewayEnv();
    const portalUrl = provisionBaseURL || dataBaseURL;

    const sub = await this.getLogtoSub(userId);
    if (!sub) return { bound: false as const, portalUrl, reason: 'no_logto_identity' as const };

    let gatewayAccount = await this.fetchAccount(sub);
    if (!gatewayAccount && autoProvision) {
      await this.autoProvisionAccount(userId, sub);
      gatewayAccount = await this.fetchAccount(sub, true);
    }
    if (!gatewayAccount) return { bound: false as const, portalUrl, reason: 'not_bound' as const };

    const token = await this.ensureToken(sub);
    return { account: gatewayAccount, bound: true as const, portalUrl, tokenGroup: token.group };
  };

  /**
   * Fire-and-forget warm-up used by the Logto sign-in hook: pre-mints the
   * relay key so the first chat message doesn't pay the provisioning
   * round-trip. Never throws — the chat path lazily self-heals anyway.
   */
  prefetchOnSignIn = async (userId: string, sub: string) => {
    try {
      if (!isNewApiGatewayEnabled()) return;
      const { autoProvision } = getGatewayEnv();
      const existing = await this.fetchAccount(sub, true);
      if (!existing && !autoProvision) return;
      await this.ensureUserApiKey(userId);
    } catch (e) {
      console.warn('[NewApiGateway] sign-in prefetch failed (lazy provisioning will retry):', e);
    }
  };

  private provisionUserApiKey = async (userId: string) => {
    const { dataBaseURL, autoProvision } = getGatewayEnv();
    const sub = await this.requireSub(userId);

    let gatewayAccount = await this.fetchAccount(sub, true);
    if (!gatewayAccount && autoProvision) {
      await this.autoProvisionAccount(userId, sub);
      gatewayAccount = await this.fetchAccount(sub, true);
    }
    if (!gatewayAccount) throw new NewApiUnboundError();

    const token = await this.ensureToken(sub);
    const baseURL = dataBaseURL;
    await this.persistKeyVaults(userId, { apiKey: token.key, ...(baseURL ? { baseURL } : {}) });

    return { apiKey: token.key, baseURL };
  };

  private ensureToken = async (sub: string): Promise<{ group: string; key: string }> => {
    const res = await this.request('POST', '/api/provision/token', {
      name: MANAGED_TOKEN_NAME,
      sub,
    });
    if (res.status === 404) throw new NewApiUnboundError();
    const data = res.body?.data as any;
    if (!res.body?.success || !data?.key) {
      throw new Error(
        res.body?.message || `gateway token provisioning failed (status ${res.status})`,
      );
    }
    return { group: data.group ?? '', key: data.key };
  };

  private autoProvisionAccount = async (userId: string, sub: string) => {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    const res = await this.request('POST', '/api/provision/user', {
      display_name: user?.fullName || user?.username || undefined,
      email: user?.email || undefined,
      sub,
      username: user?.username || undefined,
    });
    if (!res.body?.success) {
      throw new Error(
        res.body?.message || `gateway account provisioning failed (status ${res.status})`,
      );
    }
    accountCache.delete(sub);
  };

  private persistKeyVaults = async (userId: string, keyVaults: Record<string, string>) => {
    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    const aiProviderModel = new AiProviderModel(this.db, userId);
    await aiProviderModel.updateConfig(
      PROVIDER_ID,
      { keyVaults },
      gateKeeper.encrypt,
      KeyVaultsGateKeeper.getUserKeyVaults,
    );
  };

  private requireSub = async (userId: string) => {
    const sub = await this.getLogtoSub(userId);
    if (!sub) throw new NewApiUnboundError('this account has no Logto identity');
    return sub;
  };

  private request = async <T = unknown>(
    method: string,
    path: string,
    body?: object,
  ): Promise<{ body: GatewayResponse<T> | undefined; status: number }> => {
    const { key, provisionBaseURL } = getGatewayEnv();
    if (!key || !provisionBaseURL) throw new Error('new-api provision gateway is not configured');

    const res = await fetch(`${provisionBaseURL}${path}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    let parsed: GatewayResponse<T> | undefined;
    try {
      parsed = (await res.json()) as GatewayResponse<T>;
    } catch {
      parsed = undefined;
    }
    return { body: parsed, status: res.status };
  };

  private mapAccount = (
    raw: any,
    res: { body: GatewayResponse<unknown> | undefined; status: number },
  ): GatewayAccount => {
    if (!raw) {
      throw new Error(
        res.body?.message || `unexpected gateway account response (status ${res.status})`,
      );
    }
    return {
      displayName: raw.display_name ?? '',
      group: raw.group ?? 'default',
      quota: raw.quota ?? 0,
      quotaPerUnit: raw.quota_per_unit ?? 500_000,
      status: raw.status ?? 1,
      usableGroups: raw.usable_groups ?? {},
      usedQuota: raw.used_quota ?? 0,
      userId: raw.user_id,
      username: raw.username ?? '',
    };
  };
}

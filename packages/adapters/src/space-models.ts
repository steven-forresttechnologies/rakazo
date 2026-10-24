import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { ModelCredential } from "@rakazo/contracts";
import type { ConnectedModelChoice } from "@rakazo/core";
import { connectedModelChoices } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { comparePreferenceOrder, newestModelCredentialOrder } from "@rakazo/db";
import { modelCredentialDto } from "./model-connect.js";
import { modelCredentialAuthKindsForSpace } from "./model-selection.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { CodexLiveCatalog } from "./pi-codex-catalog.js";
import { applyCodexLiveCatalog, codexLiveCatalogsForSpace } from "./pi-codex-catalog.js";
import type { ProviderCatalogCache } from "./pi-live-catalog.js";
import {
  applyProviderLiveCatalog,
  providerCatalogCache,
  providerLiveCatalogsForSpace,
  savedCatalogSelections,
} from "./pi-live-catalog.js";
import type { PiCatalogEntry } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";

type Scope = { userId: string; spaceId: string };

export type SpaceModelCatalogDeps = {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  /** The provider Rakazo credits pay for, when model credits are on. */
  hostedProvider?: string;
  codexCatalog?: CodexLiveCatalog;
  providerCatalog?: ProviderCatalogCache;
  refreshExpiredCredential: (scope: Scope, secretId: string, provider: string) => void;
};

export type SpaceCatalogEntry = PiCatalogEntry & { managed?: true };

/** The model catalog this space can browse, with live per-account lists merged in. */
export async function listSpaceModelCatalog(
  deps: SpaceModelCatalogDeps,
  scope: Scope,
): Promise<SpaceCatalogEntry[]> {
  const auth = await modelCredentialAuthKindsForSpace(
    deps.prisma,
    deps.secretStore,
    scope,
    deps.hostedProvider,
  );
  const available = listAvailablePiCatalog(auth.byProvider, auth.byModel);
  const [live, providerLive] = await Promise.all([
    deps.codexCatalog
      ? codexLiveCatalogsForSpace(deps.prisma, deps.secretStore, scope, auth, deps.codexCatalog, {
          // An expired bearer yields no catalog this round; kick the runtime's
          // locked refresh so the next read can see the account's real list.
          onExpiredToken: (secretId) =>
            deps.refreshExpiredCredential(scope, secretId, CHATGPT_OAUTH_PROVIDER),
        })
      : new Map(),
    providerLiveCatalogsForSpace(
      deps.prisma,
      deps.secretStore,
      scope,
      auth,
      deps.providerCatalog ?? providerCatalogCache,
    ),
  ]);
  const codexMerged = live.size > 0 ? applyCodexLiveCatalog(available, auth, live) : available;
  const selected = providerLive.size
    ? await savedCatalogSelections(deps.prisma, scope.userId)
    : new Set<string>();
  return applyProviderLiveCatalog(codexMerged, auth, providerLive, selected).map((entry) =>
    entry.provider === auth.managedProvider
      ? {
          ...entry,
          managed: true as const,
          billing:
            auth.secretIdByModel[entry.provider]?.[entry.id] ||
            auth.secretIdByProvider[entry.provider]
              ? entry.billing
              : "Uses Rakazo credits",
        }
      : entry,
  );
}

/**
 * The user's model connections with this space's preferences. Throws
 * SecretStoreUnavailableError when the store is down; any other unreadable
 * secret lists the connection without its key details.
 */
export async function listSpaceModelCredentials(
  deps: Pick<SpaceModelCatalogDeps, "prisma" | "secretStore">,
  scope: Scope,
): Promise<ModelCredential[]> {
  const rows = await deps.prisma.userModelCredential.findMany({
    where: { userId: scope.userId },
    include: {
      preferences: { where: { userId: scope.userId, spaceId: scope.spaceId } },
    },
    orderBy: newestModelCredentialOrder,
  });
  const secrets = rows.length
    ? await deps.prisma.secret.findMany({
        where: { id: { in: rows.map((row) => row.secretId) }, userId: scope.userId, spaceId: null },
        select: { id: true, ciphertext: true },
      })
    : [];
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const preferenceRanks = new Map(
    rows
      .flatMap((row) => row.preferences)
      .sort(comparePreferenceOrder)
      .map((preference, index) => [preference.id, index]),
  );
  return Promise.all(
    rows.map(async (row) => {
      const preference = row.preferences[0];
      const selected = {
        ...row,
        isDefault: preference?.isDefault ?? false,
        defaultModel: preference?.modelId ?? null,
        thinkingLevel: preference?.thinkingLevel ?? null,
      };
      const dto = (plaintext?: string) => ({
        ...modelCredentialDto(selected, plaintext),
        ...(preference ? { preferenceRank: preferenceRanks.get(preference.id) } : {}),
      });
      const ciphertext = ciphertextById.get(row.secretId);
      if (!ciphertext) return dto();
      try {
        return dto(await deps.secretStore.load(ciphertext, row.secretId));
      } catch (error) {
        if (error instanceof SecretStoreUnavailableError) throw error;
        return dto();
      }
    }),
  );
}

/** The models a bot in this space can be set to: the same list as the bot settings picker. */
export async function listSpaceModelChoices(
  deps: SpaceModelCatalogDeps,
  scope: Scope,
): Promise<ConnectedModelChoice[]> {
  const [credentials, catalog] = await Promise.all([
    listSpaceModelCredentials(deps, scope),
    listSpaceModelCatalog(deps, scope),
  ]);
  return connectedModelChoices(credentials, catalog);
}

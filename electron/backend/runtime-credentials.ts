import type { CredentialOverview, CredentialRemoveResult } from "../shared/credential-overview.js";
import { classifyCredentials, type CredentialOwnerState } from "./credential-classifier.js";
import { getLogger } from "./logger.js";

const log = getLogger("credentials");

interface CredentialStoreLike {
  listRefs(): string[];
  deleteSecret(ref: string): Promise<void>;
  storageKind?(ref: string): "encrypted" | "plain" | null;
  isEncryptionAvailable(): boolean;
}

export interface RuntimeCredentialsDeps {
  getState: () => CredentialOwnerState;
  credentialStore: CredentialStoreLike;
  broadcastState: () => void;
}

/**
 * The overview of credentials held for external systems, and their removal. Desktop only: the remote server has
 * no counterpart. The list is metadata; the removal re-classifies the reference here, so a caller cannot name
 * anything the overview would not have shown.
 */
export function createRuntimeCredentials(deps: RuntimeCredentialsDeps) {
  const classifyStored = () => classifyCredentials(deps.getState(), deps.credentialStore.listRefs());

  async function removeEntry(entry: ReturnType<typeof classifyStored>[number]): Promise<void> {
    await deps.credentialStore.deleteSecret(entry.ref);
    log.info("credential removed", {
      system: entry.system,
      kind: entry.kind,
      ownerId: entry.ownerId,
      orphan: entry.orphan,
    });
  }

  return {
    list(): CredentialOverview {
      const encryptionAvailable = deps.credentialStore.isEncryptionAvailable();
      return {
        rows: classifyStored().map((entry) => ({
          ...entry,
          storage: deps.credentialStore.storageKind?.(entry.ref) ?? (encryptionAvailable ? "encrypted" : "plain"),
        })),
        encryptionAvailable,
      };
    },

    async remove(ref: string): Promise<CredentialRemoveResult> {
      const entry = classifyStored().find((item) => item.ref === ref);
      if (!entry) throw new Error("This credential is not one strIDEterm lets you remove here.");
      await removeEntry(entry);
      deps.broadcastState();
      return { removed: 1 };
    },

    async removeOrphans(): Promise<CredentialRemoveResult> {
      const orphans = classifyStored().filter((entry) => entry.orphan);
      let removed = 0;
      let failure: unknown;
      for (const entry of orphans) {
        try {
          await removeEntry(entry);
          removed += 1;
        } catch (error) {
          failure ??= error;
          log.warn("orphan credential could not be removed", {
            system: entry.system,
            kind: entry.kind,
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (removed > 0) deps.broadcastState();
      if (failure) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        throw new Error(`Removed ${removed} of ${orphans.length} unused credentials. ${reason}`);
      }
      return { removed };
    },
  };
}

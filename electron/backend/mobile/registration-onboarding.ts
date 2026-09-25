export interface MobileRegistrationOnboarding {
  bound(): Promise<boolean>;
  explicitlyConfigured(): Promise<void>;
  unbound(): Promise<void>;
}

export function createMobileRegistrationOnboarding(deps: {
  readMarker(): string | null;
  writeMarker(_marker: "pending" | "configured"): Promise<void>;
  clearMarker(): Promise<void>;
  enable(): Promise<void>;
}): MobileRegistrationOnboarding {
  let queue: Promise<unknown> = Promise.resolve();
  let explicitChoiceRevision = 0;

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    bound() {
      const choiceRevision = explicitChoiceRevision;
      return serialize(async () => {
        if (choiceRevision !== explicitChoiceRevision) return false;
        if (deps.readMarker() === "configured") return false;

        await deps.writeMarker("pending");
        if (choiceRevision !== explicitChoiceRevision) {
          await deps.writeMarker("configured");
          return false;
        }
        await deps.enable();
        await deps.writeMarker("configured");
        return true;
      });
    },
    explicitlyConfigured() {
      // Publish intent synchronously so a queued first-registration setup cannot race past a
      // deliberate settings choice while its durable marker write waits in the queue.
      explicitChoiceRevision += 1;
      return serialize(() => deps.writeMarker("configured"));
    },
    unbound() {
      explicitChoiceRevision += 1;
      return serialize(() => deps.clearMarker());
    },
  };
}

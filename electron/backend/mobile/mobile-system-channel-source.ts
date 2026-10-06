export function createCachedMobileSystemPayloadSource<T>(options: {
  getPayload: () => T;
  subscribe: (listener: (payload: T) => void) => () => void;
}) {
  let cachedPayload: T | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    getPayload(): T {
      if (!unsubscribe) return options.getPayload();
      cachedPayload ??= options.getPayload();
      return cachedPayload;
    },
    subscribe(listener: () => void): () => void {
      if (!unsubscribe) {
        unsubscribe = options.subscribe((payload) => {
          cachedPayload = payload;
          listener();
        });
      }
      const subscription = unsubscribe;
      return () => {
        if (unsubscribe !== subscription) return;
        subscription();
        unsubscribe = null;
        cachedPayload = null;
      };
    },
  };
}

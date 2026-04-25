import type { InjectionKey } from "vue";

// Typed injection key for the transport/api instance.
// The Transport type will be filled in during Phase 7 (transport.js migration).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const apiKey: InjectionKey<any> = Symbol("api");

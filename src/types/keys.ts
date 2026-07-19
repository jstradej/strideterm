import type { InjectionKey } from "vue";
import type { Transport } from "../transport.js";

// Typed injection key for the transport/api instance.
export const apiKey: InjectionKey<Transport> = Symbol("api");

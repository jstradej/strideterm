import type { ComputedRef, InjectionKey, Ref } from "vue";
import type { Transport } from "../transport.js";
import type { AppUpdateStatus } from "../../electron/shared/app-update.js";

// Typed injection key for the transport/api instance.
export const apiKey: InjectionKey<Transport> = Symbol("api");
export const appUpdateStatusKey: InjectionKey<Ref<AppUpdateStatus>> = Symbol("appUpdateStatus");

// Workspace that owns the Files pane being rendered; a grid cell can show a workspace other than the active one.
export const filesOwnerWorkspaceIdKey: InjectionKey<ComputedRef<string | null>> = Symbol("filesOwnerWorkspaceId");

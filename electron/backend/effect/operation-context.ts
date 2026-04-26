import { AsyncLocalStorage } from "node:async_hooks";

export interface OperationContext {
  readonly workspaceId?: string;
  readonly opId: string;
  readonly correlationId?: string;
}

// AsyncLocalStorage adapter — lets any code (logger proxy, IPC handlers)
// read the current operation context synchronously inside an async call tree.
// withOperationPromise in runtime.ts populates this for every IPC call.
export const operationContextStorage = new AsyncLocalStorage<OperationContext>();

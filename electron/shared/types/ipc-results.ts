export interface OkResult<T> {
  ok: true;
  payload: T;
}

export interface ErrResult {
  ok: false;
  error: string;
}

export type IpcResult<T> = OkResult<T> | ErrResult;
export interface AzureClosedPrCleanupSkipped {
  workspaceId: string;
  name: string;
  reason: string;
}

export interface AzureClosedPrCleanupError {
  workspaceId: string;
  name: string;
  error: string;
}

export interface AzureClosedPrCleanupResult {
  deleted: number;
  skipped: AzureClosedPrCleanupSkipped[];
  errors: AzureClosedPrCleanupError[];
}

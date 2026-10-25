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

/** The cleanup was started; its result arrives as `azure:closed-pr-cleanup:finished`. */
export interface AzureClosedPrCleanupStarted {
  started: true;
}

/** A review Git operation was started; its outcome arrives as `review-git:operation`. */
export interface ReviewGitStarted {
  started: true;
  operationId: string;
}

export interface ReviewPrActionConfirmationResult {
  status: "started" | "starting" | "rejected" | "expired";
  operationId?: string;
}

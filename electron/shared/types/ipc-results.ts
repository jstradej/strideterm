export interface OkResult<T> {
  ok: true;
  payload: T;
}

export interface ErrResult {
  ok: false;
  error: string;
}

export type IpcResult<T> = OkResult<T> | ErrResult;

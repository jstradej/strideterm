/**
 * An error whose message is safe to hand back to the caller and whose HTTP
 * status is the caller's doing, not the server's: the request itself was
 * refused (bad input, a target outside the caller's profile). `remote-server.ts`
 * answers with `status` (400 unless a refusal says otherwise, e.g. 403) instead
 * of the generic 500.
 */
export class ClientRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ClientRequestError";
    this.status = status;
  }
}

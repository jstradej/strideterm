import { Data } from "effect";

export class TelegramApiError extends Data.TaggedError("TelegramApiError")<{
  readonly method: string;
  readonly statusCode: number;
  readonly description: string;
}> {}

export class TelegramAuthError extends Data.TaggedError("TelegramAuthError")<{
  readonly method: string;
  readonly description: string;
}> {}

export class TelegramRateLimitError extends Data.TaggedError("TelegramRateLimitError")<{
  readonly method: string;
  readonly retryAfterSec: number;
  readonly description: string;
}> {}

export class TelegramNetworkError extends Data.TaggedError("TelegramNetworkError")<{
  readonly method: string;
  readonly cause: unknown;
}> {}

export type TelegramError = TelegramApiError | TelegramAuthError | TelegramRateLimitError | TelegramNetworkError;

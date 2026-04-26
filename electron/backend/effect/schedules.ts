import { Schedule } from "effect";

// HTTP retry: 200 ms exponential, max 3 retries.
// Add Schedule.while to the caller if you want to skip non-retryable errors.
export const httpRetry = Schedule.both(Schedule.exponential("200 millis"), Schedule.recurs(3));

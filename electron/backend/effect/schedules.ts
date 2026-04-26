import { Schedule } from "effect";

// Exponential backoff with a hard attempt cap.
// Delays start at 500 ms and grow exponentially; stops after 5 retries.
export const exponentialBackoff = Schedule.both(Schedule.exponential("500 millis"), Schedule.recurs(5));

// Fixed interval retry.
export const fixedRetry = (delayMs: number, attempts: number) =>
  Schedule.both(Schedule.fixed(`${delayMs} millis`), Schedule.recurs(attempts));

// HTTP retry: 200 ms exponential, max 3 retries.
// Add Schedule.while to the caller if you want to skip non-retryable errors.
export const httpRetry = Schedule.both(Schedule.exponential("200 millis"), Schedule.recurs(3));

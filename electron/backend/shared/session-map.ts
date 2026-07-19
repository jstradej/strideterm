/**
 * Generic sessionId -> live session bookkeeping. Centralizes the `Map`
 * operations that are identical across every "one long-lived child
 * process/pty per sessionId" manager (docker log tail, docker shell exec,
 * ...): add, look up, stop-and-remove a single session, and stop everything.
 *
 * Each manager still owns its own session class, event wiring, and
 * stream-specific methods — this only replaces the raw `Map` bookkeeping, so
 * callers that need different lifecycle semantics (e.g. whether a session's
 * own "close" event should also drop it from the map) keep deciding that
 * themselves via `delete()` vs. `remove()`.
 */
export class SessionMap<T extends { stop(): void }> {
  private sessions = new Map<string, T>();

  get(sessionId: string): T | undefined {
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, session: T): void {
    this.sessions.set(sessionId, session);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  hasAny(): boolean {
    return this.sessions.size > 0;
  }

  /**
   * Drop the bookkeeping entry without calling stop() — for callers that
   * already know the session stopped itself (e.g. from its own "close"
   * event handler).
   */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Stop and remove a single session. No-op if the sessionId isn't tracked. */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stop();
    this.sessions.delete(sessionId);
  }

  /** Stop every tracked session and clear the map. */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }
}

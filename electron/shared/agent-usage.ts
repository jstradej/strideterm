export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** The CLI displayed a rounded percentage, including at the 100% boundary. */
  rounded?: boolean;
  /** Duration of the provider's reported usage window, when known. */
  durationMinutes?: number;
  /** Provider-reported model or pool scope; absent means account-wide. */
  scope?: string;
  /** Unix timestamp in milliseconds. */
  resetsAt?: number;
}

/** Provider-granted credits that each reset the account's quota once. */
export interface UsageResetCredits {
  available: number;
  /** Unix ms, ascending, for the available credits whose expiry is known. */
  expiresAt: number[];
}

/** Identity and quota for one independently authenticated CLI configuration. */
export interface UsageAccountReading {
  account?: { label: string; key: string };
  windows: UsageWindow[];
  resetCredits?: UsageResetCredits;
}

/** A tracked configuration, a past reading, or metadata for an additional account. */
export interface UsageAccountSnapshot {
  id: string;
  label: string;
  status: "separate-login" | "last-seen" | "listed" | "candidate";
  /** This login returned quota without an account identity. Its local label may name a folder. */
  identityUnknown?: true;
  checkedAt?: number;
  windows?: UsageWindow[];
  unavailable?: string;
  removable?: boolean;
  sameAsDefault?: true;
}

/** Default local account quotas, or an observation from the selected Gemini terminal. */
export interface AgentUsage extends UsageAccountReading {
  provider: "claude" | "codex" | "gemini";
  checkedAt: number;
  otherAccounts?: UsageAccountSnapshot[];
  unavailable?: string;
}

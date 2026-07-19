/**
 * Isolated coverage for the draft/test/submit scaffolding shared by
 * AzureConnectionDialog and GitHubConnectionDialog: busy-flag bookkeeping
 * around "Test connection" / submit, and the "Browse" directory picker.
 * This logic was duplicated near-verbatim in both dialogs before being
 * extracted here (see each dialog's own .test.ts for its picker-rejection
 * regression coverage through the full component).
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionDialogForm } from "./useConnectionDialogForm.js";

describe("useConnectionDialogForm", () => {
  beforeEach(() => {
    // pickPath falls back to the notification store on a rejected picker.
    setActivePinia(createPinia());
  });

  const payload = { label: "test-connection" };

  test("testConnection stores the verify result and clears busy", async () => {
    const form = useConnectionDialogForm({
      draft: { reviewRoot: "" },
      defaultReviewRoot: () => "",
      buildPayload: () => payload,
      verify: vi.fn().mockResolvedValue({ ok: true }),
      onSave: vi.fn(),
      providerLabel: "Test Provider",
    });

    const pending = form.testConnection();
    expect(form.busy.value).toBe(true);
    await pending;

    expect(form.busy.value).toBe(false);
    expect(form.verification.value).toEqual({ ok: true });
    expect(form.errorMessage.value).toBe("");
  });

  test("testConnection on rejection sets errorMessage and clears any stale verification", async () => {
    const form = useConnectionDialogForm({
      draft: { reviewRoot: "" },
      defaultReviewRoot: () => "",
      buildPayload: () => payload,
      verify: vi.fn().mockRejectedValue(new Error("bad token")),
      onSave: vi.fn(),
      providerLabel: "Test Provider",
    });
    form.verification.value = { stale: true };

    await form.testConnection();

    expect(form.errorMessage.value).toBe("bad token");
    expect(form.verification.value).toBeNull();
    expect(form.busy.value).toBe(false);
  });

  test("testConnection falls back to a provider-labeled message when the error has none", async () => {
    const form = useConnectionDialogForm({
      draft: { reviewRoot: "" },
      defaultReviewRoot: () => "",
      buildPayload: () => payload,
      verify: vi.fn().mockRejectedValue({}),
      onSave: vi.fn(),
      providerLabel: "Test Provider",
    });

    await form.testConnection();

    expect(form.errorMessage.value).toBe("Test Provider connection test failed.");
  });

  test("handleSubmit calls onSave with the built payload and leaves busy true on success", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const form = useConnectionDialogForm({
      draft: { reviewRoot: "" },
      defaultReviewRoot: () => "",
      buildPayload: () => payload,
      verify: vi.fn(),
      onSave,
      providerLabel: "Test Provider",
    });

    await form.handleSubmit();

    expect(onSave).toHaveBeenCalledWith(payload);
    // Intentionally left true on success — the caller closes the dialog; only
    // the failure path resets it so the form can be retried.
    expect(form.busy.value).toBe(true);
  });

  test("handleSubmit on rejection sets errorMessage and resets busy", async () => {
    const form = useConnectionDialogForm({
      draft: { reviewRoot: "" },
      defaultReviewRoot: () => "",
      buildPayload: () => payload,
      verify: vi.fn(),
      onSave: vi.fn().mockRejectedValue(new Error("save failed")),
      providerLabel: "Test Provider",
    });

    await form.handleSubmit();

    expect(form.errorMessage.value).toBe("save failed");
    expect(form.busy.value).toBe(false);
  });

  test("browseReviewRoot is a no-op when no browseDirectory is supplied", async () => {
    const draft = { reviewRoot: "" };
    const form = useConnectionDialogForm({
      draft,
      defaultReviewRoot: () => "",
      buildPayload: () => payload,
      verify: vi.fn(),
      onSave: vi.fn(),
      providerLabel: "Test Provider",
    });

    await form.browseReviewRoot();

    expect(draft.reviewRoot).toBe("");
  });

  test("browseReviewRoot seeds the picker with the current reviewRoot and stores the picked path", async () => {
    const draft = { reviewRoot: "C:/existing" };
    const browseDirectory = vi.fn().mockResolvedValue("C:/picked");
    const form = useConnectionDialogForm({
      draft,
      defaultReviewRoot: () => "C:/default",
      browseDirectory,
      buildPayload: () => payload,
      verify: vi.fn(),
      onSave: vi.fn(),
      providerLabel: "Test Provider",
    });

    await form.browseReviewRoot();

    expect(browseDirectory).toHaveBeenCalledWith("C:/existing");
    expect(draft.reviewRoot).toBe("C:/picked");
  });

  test("browseReviewRoot falls back to defaultReviewRoot() when draft.reviewRoot is empty", async () => {
    const draft = { reviewRoot: "" };
    const browseDirectory = vi.fn().mockResolvedValue("C:/picked");
    const form = useConnectionDialogForm({
      draft,
      defaultReviewRoot: () => "C:/default",
      browseDirectory,
      buildPayload: () => payload,
      verify: vi.fn(),
      onSave: vi.fn(),
      providerLabel: "Test Provider",
    });

    await form.browseReviewRoot();

    expect(browseDirectory).toHaveBeenCalledWith("C:/default");
  });

  test("browseReviewRoot leaves draft.reviewRoot unchanged when the picker is cancelled", async () => {
    const draft = { reviewRoot: "C:/existing" };
    const browseDirectory = vi.fn().mockResolvedValue(null);
    const form = useConnectionDialogForm({
      draft,
      defaultReviewRoot: () => "",
      browseDirectory,
      buildPayload: () => payload,
      verify: vi.fn(),
      onSave: vi.fn(),
      providerLabel: "Test Provider",
    });

    await form.browseReviewRoot();

    expect(draft.reviewRoot).toBe("C:/existing");
  });
});

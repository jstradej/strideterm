import { describe, it, expect } from "vitest";
import { reviewNotificationText } from "./review-notification-text.js";

describe("reviewNotificationText", () => {
  it("drops the PR title the Azure new-PR headline carries, so it is not printed twice", () => {
    expect(
      reviewNotificationText(
        "New pull request: ACME_CORE / orders-core — Retry the outbox on a broker restart",
        "#33007 by Doe, Jane",
        "Retry the outbox on a broker restart",
      ),
    ).toEqual({
      prTitle: "Retry the outbox on a broker restart",
      event: "New pull request: ACME_CORE / orders-core",
      detail: "#33007 by Doe, Jane",
    });
  });

  it("names the PR on an event whose own text never did", () => {
    expect(reviewNotificationText("New comment on orders-core #12", "Jana: looks good", "Fix login")).toEqual({
      prTitle: "Fix login",
      event: "New comment on orders-core #12",
      detail: "Jana: looks good",
    });
  });

  it("hides a body that only repeats the title, and keeps the author of 'author: title'", () => {
    expect(reviewNotificationText("Ready for review: repo #3", "Fix login", "Fix login").detail).toBe("");
    expect(reviewNotificationText("New pull request: org/repo #3", "Jana: Fix login", "Fix login").detail).toBe(
      "by Jana",
    );
  });

  it("leaves an entry with no PR title unchanged", () => {
    expect(reviewNotificationText("Connection failed", "401", "")).toEqual({
      prTitle: "",
      event: "Connection failed",
      detail: "401",
    });
  });
});

import { describe, expect, test } from "bun:test";

describe("API compatibility errors", () => {
  test("preserves machine-readable 426 details", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    const { apiErrorFromPayload } = await import("./api");
    const error = apiErrorFromPayload({
      error: "This Raven version is too old.",
      serviceAccess: "blocked",
      compatibility: {
        status: "upgrade_required",
        reasonCode: "client_below_minimum",
        message: "Update Raven before joining a Nest.",
        protocolVersion: 1,
        requiredCapabilities: [],
        missingCapabilities: [],
      },
    }, 426);
    expect(error.status).toBe(426);
    expect(error.reasonCode).toBe("client_below_minimum");
    expect(error.serviceAccess).toBe("blocked");
    expect(error.compatibility?.status).toBe("upgrade_required");
  });
});

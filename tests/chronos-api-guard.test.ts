import { afterEach, describe, expect, it, vi } from "vitest";

function createRequest(headers: Record<string, string> = {}) {
  const normalized = new Headers(headers);
  return {
    headers: {
      get(name: string) {
        return normalized.get(name);
      },
    },
    cookies: {
      get() {
        return undefined;
      },
    },
  } as any;
}

async function loadGuardModule() {
  vi.resetModules();
  return import("../presence/displays/chronos-mirror-v2/src/lib/api-guard");
}

describe("Chronos API guard", () => {
  afterEach(() => {
    delete process.env.KYBERION_API_TOKEN;
    delete process.env.KYBERION_LOCALADMIN_TOKEN;
    delete process.env.KYBERION_ALLOW_UNAUTH_REMOTE;
    delete process.env.KYBERION_LOCALHOST_AUTOADMIN;
    vi.resetModules();
  });

  it("keeps localhost readonly by default", async () => {
    const guard = await loadGuardModule();
    const req = createRequest({
      "x-forwarded-for": "127.0.0.1",
    });

    expect(guard.resolveChronosAccessRole(req)).toBe("readonly");
  });

  it("promotes localhost to localadmin only when opt-in flag is enabled", async () => {
    process.env.KYBERION_LOCALHOST_AUTOADMIN = "true";
    const guard = await loadGuardModule();
    const req = createRequest({
      "x-forwarded-for": "127.0.0.1",
    });

    expect(guard.resolveChronosAccessRole(req)).toBe("localadmin");
  });

  it("still honors explicit readonly token over localhost auto-admin", async () => {
    process.env.KYBERION_LOCALHOST_AUTOADMIN = "true";
    process.env.KYBERION_API_TOKEN = "readonly-token";
    const guard = await loadGuardModule();
    const req = createRequest({
      "x-forwarded-for": "127.0.0.1",
      authorization: "Bearer readonly-token",
    });

    expect(guard.resolveChronosAccessRole(req)).toBe("readonly");
  });

  it("still honors explicit localadmin token over localhost auto-admin", async () => {
    process.env.KYBERION_LOCALHOST_AUTOADMIN = "true";
    process.env.KYBERION_LOCALADMIN_TOKEN = "localadmin-token";
    const guard = await loadGuardModule();
    const req = createRequest({
      "x-forwarded-for": "127.0.0.1",
      authorization: "Bearer localadmin-token",
    });

    expect(guard.resolveChronosAccessRole(req)).toBe("localadmin");
  });
});

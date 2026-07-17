import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/main/api-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credential-bearing API requests", () => {
  it("refuses redirects and attaches credentials only to the configured URL", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ revision: 0, value: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiUrl: "https://clipboard.example.com",
      deviceToken: "cbm_" + "a".repeat(48),
      cloudflareAccess: {
        clientId: "access-id",
        clientSecret: "access-secret",
      },
    });

    await client.getState();

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe("https://clipboard.example.com/v1/state");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      `Bearer ${"cbm_" + "a".repeat(48)}`,
    );
    expect(headers.get("cf-access-client-id")).toBe("access-id");
    expect(headers.get("cf-access-client-secret")).toBe("access-secret");
  });
});

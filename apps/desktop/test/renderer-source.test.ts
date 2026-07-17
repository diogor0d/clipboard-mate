import { describe, expect, it } from "vitest";
import { getDevelopmentRendererUrl } from "../src/main/renderer-source.js";

describe("development renderer trust", () => {
  it("ignores the development renderer URL in packaged builds", () => {
    expect(
      getDevelopmentRendererUrl(true, {
        ELECTRON_RENDERER_URL: "https://attacker.invalid",
      }),
    ).toBeUndefined();
  });

  it("allows the development renderer URL in unpackaged builds", () => {
    expect(
      getDevelopmentRendererUrl(false, {
        ELECTRON_RENDERER_URL: "http://localhost:5173",
      }),
    ).toBe("http://localhost:5173");
  });
});

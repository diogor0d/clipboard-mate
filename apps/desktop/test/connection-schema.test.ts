import { desktopConnectionSchema } from "@clipboard-mate/contracts";
import { describe, expect, it } from "vitest";

const connection = (apiUrl: string) => ({
  apiUrl,
  deviceToken: "cbm_" + "a".repeat(48),
});

describe("desktop API URL policy", () => {
  it.each([
    "https://clips.example.com",
    "https://clips.example.com/relay",
    "http://127.0.0.1:43120",
    "http://localhost:43120",
  ])("accepts a secure or exact loopback URL: %s", (apiUrl) => {
    expect(desktopConnectionSchema.safeParse(connection(apiUrl)).success).toBe(
      true,
    );
  });

  it.each([
    "http://clips.example.com",
    "http://localhost.attacker.example",
    "http://127.0.0.1@attacker.example",
    "https://user:password@clips.example.com",
    "https://clips.example.com?redirect=http://attacker.example",
  ])("rejects a URL that could leak credentials: %s", (apiUrl) => {
    expect(desktopConnectionSchema.safeParse(connection(apiUrl)).success).toBe(
      false,
    );
  });
});

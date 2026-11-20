import { describe, expect, it } from "vitest";
import { createSealer } from "./crypto";

const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("credential sealing", () => {
  it("round-trips and uses a fresh IV each time", async () => {
    const s = createSealer(key());
    const a = await s.seal("hunter2 hunter2");
    const b = await s.seal("hunter2 hunter2");
    expect(a).not.toBe(b);
    expect(a).not.toContain("hunter2");
    expect(await s.open(a)).toBe("hunter2 hunter2");
  });

  it("fails with the wrong key or tampered data, and without a key", async () => {
    const sealed = await createSealer(key()).seal("secret");
    await expect(createSealer(key()).open(sealed)).rejects.toBeDefined();
    const s = createSealer(key());
    const tampered = (await s.seal("secret")).slice(0, -2) + "AA";
    await expect(s.open(tampered)).rejects.toBeDefined();
    await expect(createSealer(undefined).seal("x")).rejects.toThrow(/MAIL_SESSION_KEY/);
  });
});

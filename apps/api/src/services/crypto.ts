/**
 * AES-256-GCM sealing for the mailbox password a webmail session needs to talk JMAP to the
 * mail server on the employee's behalf. Output: base64url(iv[12] || ciphertext+tag).
 */

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64Decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createSealer(keyBase64: string | undefined) {
  let keyPromise: ReturnType<typeof crypto.subtle.importKey> | null = null;
  const key = () => {
    if (!keyBase64) throw new Error("MAIL_SESSION_KEY is not configured");
    const raw = b64Decode(keyBase64);
    if (raw.length !== 32) throw new Error("MAIL_SESSION_KEY must be 32 bytes, base64-encoded");
    return (keyPromise ??= crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  };
  return {
    async seal(plain: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain)),
      );
      const out = new Uint8Array(iv.length + ct.length);
      out.set(iv);
      out.set(ct, iv.length);
      return b64urlEncode(out);
    },
    async open(sealed: string): Promise<string> {
      const data = b64Decode(sealed);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.slice(0, 12) },
        await key(),
        data.slice(12),
      );
      return new TextDecoder().decode(pt);
    },
  };
}

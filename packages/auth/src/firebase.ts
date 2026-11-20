import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Google's public keys for Firebase Auth ID tokens (JWK format). */
export const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface FirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** Second factor used for this sign-in ("totp", "phone"), or null for single-factor sign-in. */
  secondFactor: string | null;
  /** Seconds since epoch when the user last actually signed in (not token refresh). */
  authTime: number;
}

export class InvalidIdTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid Firebase ID token: ${reason}`);
    this.name = "InvalidIdTokenError";
  }
}

export interface FirebaseVerifierOptions {
  projectId: string;
  /** Override the key source (tests). Defaults to Google's remote JWKS, cached per isolate. */
  keys?: JWTVerifyGetKey;
  /**
   * Accept the Firebase Auth emulator's unsigned tokens. The caller MUST only enable this when
   * ENVIRONMENT=development; createFirebaseVerifier enforces nothing about environments itself.
   */
  allowEmulatorTokens?: boolean;
  /** Clock for tests (seconds since epoch). */
  now?: () => number;
}

export type FirebaseVerifier = (idToken: string) => Promise<FirebaseIdentity>;

let remoteKeys: JWTVerifyGetKey | undefined;

export function createFirebaseVerifier(options: FirebaseVerifierOptions): FirebaseVerifier {
  const { projectId } = options;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is not configured");
  const issuer = `https://securetoken.google.com/${projectId}`;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return async (idToken) => {
    let payload: Record<string, unknown>;
    if (options.allowEmulatorTokens && isUnsignedToken(idToken)) {
      payload = decodeJwt(idToken) as Record<string, unknown>;
      checkClaims(payload, issuer, projectId, now());
    } else {
      const keys = options.keys ?? (remoteKeys ??= createRemoteJWKSet(new URL(FIREBASE_JWKS_URL)));
      try {
        const result = await jwtVerify(idToken, keys, {
          issuer,
          audience: projectId,
          algorithms: ["RS256"],
          currentDate: new Date(now() * 1000),
        });
        payload = result.payload as Record<string, unknown>;
      } catch (err) {
        throw new InvalidIdTokenError(err instanceof Error ? err.message : "verification failed");
      }
      checkClaims(payload, issuer, projectId, now());
    }
    return toIdentity(payload);
  };
}

function isUnsignedToken(token: string): boolean {
  const [header] = token.split(".");
  if (!header) return false;
  try {
    const json = JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/"))) as { alg?: string };
    return json.alg === "none";
  } catch {
    return false;
  }
}

function checkClaims(
  payload: Record<string, unknown>,
  issuer: string,
  projectId: string,
  nowSec: number,
): void {
  if (payload.iss !== issuer) throw new InvalidIdTokenError("issuer mismatch");
  if (payload.aud !== projectId) throw new InvalidIdTokenError("audience mismatch");
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new InvalidIdTokenError("missing subject");
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) throw new InvalidIdTokenError("expired");
  if (typeof payload.iat !== "number" || payload.iat > nowSec + 60)
    throw new InvalidIdTokenError("issued in the future");
  if (typeof payload.auth_time !== "number" || payload.auth_time > nowSec + 60) {
    throw new InvalidIdTokenError("invalid auth_time");
  }
  if (typeof payload.email !== "string") throw new InvalidIdTokenError("account has no email address");
}

function toIdentity(payload: Record<string, unknown>): FirebaseIdentity {
  const firebase = (payload.firebase ?? {}) as { sign_in_second_factor?: unknown };
  return {
    uid: payload.sub as string,
    email: (payload.email as string).toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
    secondFactor: typeof firebase.sign_in_second_factor === "string" ? firebase.sign_in_second_factor : null,
    authTime: payload.auth_time as number,
  };
}

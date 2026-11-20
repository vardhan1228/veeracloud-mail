import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth,
} from "firebase/auth";

// ---------- API ----------

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] },
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(
      0,
      "network_error",
      navigator.onLine ? "Cannot reach the server. Try again shortly." : "You are offline.",
    );
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data?.code as string) ?? "http_error",
      (data?.message as string) ?? `Request failed (${res.status})`,
      data?.details as ApiError["details"],
    );
  }
  return data as T;
}

/** Raw file upload (webmail attachments). */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
  } catch {
    throw new ApiError(0, "network_error", "Upload failed. Check your connection.");
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data?.code as string) ?? "http_error",
      (data?.message as string) ?? "Upload failed",
    );
  }
  return data as T;
}

export const apiUrl = (path: string) => `${API_BASE}${path}`;

/** First field error for `field`, for inline form messages. */
export function fieldError(err: unknown, field: string): string | null {
  return err instanceof ApiError ? (err.details?.fieldErrors?.[field]?.[0] ?? null) : null;
}

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useApi<T>(path: string | null): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({
    data: null,
    error: null,
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>(path).then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (error: unknown) =>
        !cancelled &&
        setState({
          data: null,
          error: error instanceof ApiError ? error : new ApiError(0, "unknown", String(error)),
          loading: false,
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ---------- Firebase auth ----------

let app: FirebaseApp | null = null;

export function firebaseAuth(): Auth {
  if (!app) {
    const env = import.meta.env;
    if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_PROJECT_ID) {
      throw new Error("Firebase is not configured. Set VITE_FIREBASE_* in .env.local.");
    }
    app = initializeApp({
      apiKey: env.VITE_FIREBASE_API_KEY as string,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string,
      projectId: env.VITE_FIREBASE_PROJECT_ID as string,
      appId: env.VITE_FIREBASE_APP_ID as string,
    });
  }
  return getAuth(app);
}

const FIREBASE_MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
  "auth/weak-password": "Use at least 8 characters for your password.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/network-request-failed": "Network error. Check your connection.",
  "auth/operation-not-allowed":
    "Email/password sign-in is not enabled in the Firebase project (Authentication → Sign-in method).",
  "auth/configuration-not-found":
    "Firebase Authentication is not set up yet. Open the Firebase console → Authentication → Get started.",
  "auth/multi-factor-auth-required":
    "This account uses two-step verification, which this screen does not support yet.",
};

export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const code = (err as { code?: string })?.code;
  if (code && FIREBASE_MESSAGES[code]) return FIREBASE_MESSAGES[code];
  return err instanceof Error ? err.message : "Something went wrong.";
}

async function exchange(turnstileToken?: string) {
  const user = firebaseAuth().currentUser;
  if (!user) throw new Error("Not signed in");
  const idToken = await user.getIdToken(true);
  return api("/auth/session", { method: "POST", body: { idToken, turnstileToken } });
}

export async function signIn(email: string, password: string, turnstileToken?: string) {
  await signInWithEmailAndPassword(firebaseAuth(), email, password);
  return exchange(turnstileToken);
}

/** Sends Firebase's verification email to the signed-in admin (needed before ADMIN_EMAILS applies). */
export async function sendVerification() {
  const user = firebaseAuth().currentUser;
  if (!user) throw new Error("Sign in again, then send the verification email.");
  await sendEmailVerification(user);
}

export async function resetPassword(email: string) {
  await sendPasswordResetEmail(firebaseAuth(), email);
}

export async function signOut() {
  await api("/auth/logout", { method: "POST" }).catch(() => undefined);
  await firebaseSignOut(firebaseAuth()).catch(() => undefined);
}

// ---------- Tiny hash router ----------

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash.replace(/^#/, "") || "/");
}

export function navigate(path: string) {
  window.location.hash = path;
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
  );
}

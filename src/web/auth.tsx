import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { HarnessApi } from "./api";

const KEY = "harness.token";

export function readStoredToken(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // A browser with storage disabled still works for this session, just not across reloads.
  }
}

export interface AuthValue {
  token: string | null;
  api: HarnessApi;
  signIn: (token: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, initialToken, api }: {
  children: ReactNode;
  initialToken?: string | null;
  api?: HarnessApi;
}) {
  const [token, setToken] = useState<string | null>(() => (initialToken === undefined ? readStoredToken() : initialToken));
  const clientRef = useRef<HarnessApi>(api ?? new HarnessApi({ token }));
  const client = api ?? clientRef.current;
  client.setToken(token);

  const signIn = useCallback((next: string) => {
    const trimmed = next.trim();
    storeToken(trimmed);
    setToken(trimmed);
  }, []);

  const signOut = useCallback(() => {
    storeToken(null);
    setToken(null);
  }, []);

  const value = useMemo(() => ({ token, api: client, signIn, signOut }), [token, client, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

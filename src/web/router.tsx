import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface RouteMatch {
  path: string;
  params: Record<string, string>;
}

interface RouterValue {
  path: string;
  search: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

/** Programmatic navigation for code that is not inside a component prop chain. */
let currentNavigate: RouterValue["navigate"] | null = null;
export function navigate(to: string, opts?: { replace?: boolean }): void {
  if (currentNavigate) currentNavigate(to, opts);
  else if (typeof window !== "undefined") window.location.assign(hrefFor(to));
}

/** Every page in the app. The order matters only for overlapping patterns. */
export const ROUTE_PATTERNS = ["/", "/chat", "/files", "/agents", "/runs/:id", "/plugins", "/settings"] as const;

/**
 * Where the app is mounted. Empty for the server build (served from `/`); a
 * project path such as `/harness-demo` for the static demo on a hosted sub-path.
 * Route patterns are always written relative to the mount point.
 */
/**
 * Read once, at import, so the first render already knows where the app lives.
 * Only the demo build sets the flag (see demo.html); the server build is always
 * mounted at "/".
 */
function initialBase(): string {
  if (typeof document === "undefined" || typeof window === "undefined") return "";
  if (!(window as { __HARNESS_DEMO__?: boolean }).__HARNESS_DEMO__) return "";
  return new URL(".", document.baseURI).pathname.replace(/\/+$/, "");
}

let BASE = initialBase();

export function setRouterBase(base: string): void {
  BASE = base.replace(/\/+$/, "");
}

export function routerBase(): string {
  return BASE;
}

/** A route path as the browser should see it. */
export function hrefFor(to: string): string {
  if (!BASE) return to;
  return to === "/" ? `${BASE}/` : `${BASE}${to}`;
}

/** The route path for a browser pathname, with the mount point removed. */
export function pathFor(pathname: string): string {
  if (BASE && (pathname === BASE || pathname.startsWith(`${BASE}/`))) {
    const rest = pathname.slice(BASE.length);
    return rest === "" ? "/" : rest;
  }
  return pathname;
}

const currentUrl = () => (typeof window === "undefined" ? "/" : pathFor(window.location.pathname) + window.location.search);

/** The route-matching view of a URL: path only, trailing slash removed except at the root. */
export function currentPath(url: string): string {
  const path = url.split("?")[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function RouterProvider({ initial, children }: { initial?: string; children: ReactNode }) {
  const [url, setUrl] = useState(() => initial ?? currentUrl());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => setUrl(currentUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (typeof window === "undefined") { setUrl(to); return; }
    const target = hrefFor(to);
    if (opts?.replace) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
    setUrl(to);
  }, []);

  useEffect(() => { currentNavigate = navigate; }, [navigate]);

  const value = useMemo<RouterValue>(() => {
    const q = url.indexOf("?");
    return { path: q === -1 ? url : url.slice(0, q), search: q === -1 ? "" : url.slice(q), navigate };
  }, [url, navigate]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used inside RouterProvider");
  return ctx;
}

/** Path patterns use `:name` segments; the first match wins. */
export function matchRoute(routes: readonly string[], path: string): RouteMatch | null {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  for (const pattern of routes) {
    const want = pattern.split("/").filter(Boolean);
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(":")) params[want[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (want[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { path: pattern, params };
  }
  return null;
}

/** The current route as matched by the app's own table: `/runs/:id` gives `{id}`. */
export function useRoute(): RouteMatch {
  const { path } = useRouter();
  return matchRoute(ROUTE_PATTERNS, path) ?? { path, params: {} };
}

export function useSearchParams(): URLSearchParams {
  const { search } = useRouter();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function Link({ to, children, className, onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  const { navigate: go } = useRouter();
  return (
    <a
      href={hrefFor(to)}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick?.();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

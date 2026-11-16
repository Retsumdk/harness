import { afterAll, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiProvider, useApi } from "../src/web/api-context";
import { readStoredToken, storeToken } from "../src/web/auth";
import { formatBytes, relativeTime } from "../src/web/hooks";
import { HarnessApi } from "../src/web/api";
import { currentPath, hrefFor, Link, matchRoute, pathFor, ROUTE_PATTERNS, RouterProvider, setRouterBase, useRoute, useSearchParams } from "../src/web/router";
import { ChatPage } from "../src/web/pages/Chat";
import { AgentsPage } from "../src/web/pages/Agents";
import { FilesPage } from "../src/web/pages/Files";

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
};

const realStorage = (globalThis as { localStorage?: unknown }).localStorage;
const memory = fakeStorage();
(globalThis as { localStorage?: unknown }).localStorage = memory;
afterAll(() => { (globalThis as { localStorage?: unknown }).localStorage = realStorage; });

describe("token storage", () => {
  test("a token survives a reload and can be forgotten", () => {
    storeToken("tok_1");
    expect(readStoredToken()).toBe("tok_1");
    storeToken(null);
    expect(readStoredToken()).toBeNull();
    expect(memory.map.size).toBe(0);
  });

  test("a browser with storage disabled degrades to a null token instead of throwing", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => undefined };
    (globalThis as { localStorage?: unknown }).localStorage = broken;
    expect(() => storeToken("x")).not.toThrow();
    expect(readStoredToken()).toBeNull();
    (globalThis as { localStorage?: unknown }).localStorage = memory;
  });
});

describe("api context", () => {
  test("a page gets the exact client instance its provider was given", () => {
    const api = new HarnessApi({ token: "t" });
    let seen: HarnessApi | undefined;
    const Probe = () => { seen = useApi(); return <span>probe</span>; };
    renderToStaticMarkup(<ApiProvider api={api}><Probe /></ApiProvider>);
    expect(seen === api).toBe(true);
  });

  test("using the hook outside a provider is a loud developer error, not a silent null", () => {
    const Probe = () => { useApi(); return null; };
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/ApiProvider/);
  });
});

describe("formatting helpers", () => {
  test("relative time reads as words for recent and old timestamps", () => {
    const now = Date.UTC(2026, 10, 13, 12, 0, 0);
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  test("byte sizes are human-readable and an unknown size is blank", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("router in a rendered page", () => {
  test("every sidebar destination resolves to a declared pattern", () => {
    const expected: Record<string, string> = {
      "/": "/", "/chat": "/chat", "/files": "/files", "/agents": "/agents",
      "/runs/run_3": "/runs/:id", "/plugins": "/plugins", "/settings": "/settings",
    };
    for (const [path, pattern] of Object.entries(expected)) {
      expect({ path, pattern: matchRoute(ROUTE_PATTERNS, path)?.path ?? null }).toEqual({ path, pattern });
    }
    expect(matchRoute(ROUTE_PATTERNS, "/nope")).toBeNull();
  });

  test("the current path strips the query string so route matching stays exact", () => {
    expect(currentPath("/chat?c=conv_1")).toBe("/chat");
    expect(currentPath("/runs/run_3")).toBe("/runs/run_3");
  });

  test("a run page reads its id from the path and keeps the query", () => {
    const Probe = () => {
      const route = useRoute();
      const params = useSearchParams();
      return <p>{`${route.path}:${route.params.id}:${params.get("tab") ?? "-"}`}</p>;
    };
    const html = renderToStaticMarkup(
      <RouterProvider initial="/runs/run_3?tab=steps"><Probe /></RouterProvider>,
    );
    expect(html).toContain("/runs/:id:run_3:steps");
  });

  test("links render real hrefs so a middle-click still works", () => {
    const html = renderToStaticMarkup(
      <RouterProvider initial="/"><Link to="/agents">Agents</Link></RouterProvider>,
    );
    expect(html).toContain('href="/agents"');
  });
});

describe("page containers", () => {
  const api = new HarnessApi({ token: "t", fetchImpl: async () => new Response("{}", { status: 200 }) });
  const page = (node: ReactElement, path = "/") =>
    renderToStaticMarkup(
      <RouterProvider initial={path}><ApiProvider api={api}>{node}</ApiProvider></RouterProvider>,
    );

  test("each container paints a loading state before its first response arrives", () => {
    expect(page(<ChatPage />, "/chat")).toContain("Nothing said yet");
    expect(page(<FilesPage />, "/files")).toContain("Reading workspace");
    expect(page(<AgentsPage />, "/agents")).toContain("Loading agents");
  });
});

describe("mount base", () => {
  test("a hosted sub-path is stripped before routing and restored in links", () => {
    setRouterBase("/harness-demo");
    expect(pathFor("/harness-demo/files")).toBe("/files");
    expect(pathFor("/harness-demo")).toBe("/");
    expect(currentPath(pathFor("/harness-demo/runs/run_1"))).toBe("/runs/run_1");
    expect(matchRoute(ROUTE_PATTERNS, currentPath(pathFor("/harness-demo/runs/run_1"))))
      .toEqual({ path: "/runs/:id", params: { id: "run_1" } });
    expect(hrefFor("/")).toBe("/harness-demo/");
    expect(hrefFor("/agents")).toBe("/harness-demo/agents");
    const html = renderToStaticMarkup(
      <RouterProvider initial="/"><Link to="/settings">Settings</Link></RouterProvider>,
    );
    expect(html).toContain('href="/harness-demo/settings"');
    setRouterBase("");
    expect(hrefFor("/agents")).toBe("/agents");
    expect(pathFor("/agents")).toBe("/agents");
  });
});

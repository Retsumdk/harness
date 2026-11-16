import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export interface AsyncResult<T> extends AsyncState<T> {
  reload: () => void;
  setData: (value: T | null) => void;
}

/** One fetch per mount and per reload; a late response from a stale run is dropped. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef
      .current()
      .then((data) => { if (alive) setState({ data, error: null, loading: false }); })
      .catch((e: unknown) => {
        if (!alive) return;
        setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((value: T | null) => setState((s) => ({ ...s, data: value })), []);
  return { ...state, reload, setData };
}

export const relativeTime = (ts: number, now = Date.now()): string => {
  const diff = Math.max(0, now - ts);
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
};

export const formatBytes = (n?: number): string => {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

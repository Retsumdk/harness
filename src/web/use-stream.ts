import { useCallback, useEffect, useRef, useState } from "react";
import type { HarnessApi } from "./api";

/** Keeps one SSE feed open for a run while `runId` is set, and can be reopened. */
export function useRunStream(
  api: HarnessApi,
  runId: string | null,
  onEvent: (event: string, data: unknown) => void,
): { connected: boolean; reconnect: () => void } {
  const [connected, setConnected] = useState(false);
  const [nonce, setNonce] = useState(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!runId) { setConnected(false); return; }
    const abort = api.streamRun(runId, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onEvent: (event, data) => handler.current(event, data),
    });
    return () => abort();
  }, [api, runId, nonce]);

  return { connected, reconnect: useCallback(() => setNonce((n) => n + 1), []) };
}

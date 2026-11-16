/**
 * Connects the React client to the in-tab kernel by handing `HarnessApi` a
 * `fetchImpl` that routes requests into the real Hono app. Everything above this
 * line — the SSE reader, the error envelope, the page components — is unchanged
 * from the server build; only the transport is local.
 */
import { HarnessApi } from "../web/api";
import { createDemoKernel, DEMO_TOKEN, type DemoKernel, type DemoKernelOptions } from "./kernel";

export const DEMO_ORIGIN = "https://demo.harness.local";

export interface DemoClient {
  api: HarnessApi;
  kernel: DemoKernel;
}

export async function createDemoClient(opts: DemoKernelOptions = {}): Promise<DemoClient> {
  const kernel = await createDemoKernel(opts);
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, DEMO_ORIGIN).toString();
    return Promise.resolve(kernel.app.fetch(new Request(url, init)));
  };
  return { api: new HarnessApi({ baseUrl: DEMO_ORIGIN, token: DEMO_TOKEN, fetchImpl }), kernel };
}

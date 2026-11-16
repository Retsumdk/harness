import { createRoot } from "react-dom/client";
import { createDemoClient } from "../demo/client";
import { DEMO_TOKEN } from "../demo/kernel";
import App from "./App";
import "./styles.css";

/**
 * Entry point of the static demo. It builds the kernel in the tab, then mounts
 * the same React app the server build serves — no sign-in, because the demo's
 * kernel answers to a fixed token that only this page knows.
 */
const { api } = await createDemoClient();

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(<App api={api} initialToken={DEMO_TOKEN} demo />);

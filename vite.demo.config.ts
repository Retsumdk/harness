import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** The static demo: same client, in-browser kernel, relative asset paths so the
 *  bundle works from a project sub-path (GitHub Pages serves from /<repo>/). */
export default defineConfig({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../demo",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: "src/web/demo.html" },
  },
});

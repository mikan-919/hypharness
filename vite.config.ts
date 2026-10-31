import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { inertiaPages } from "@hono/inertia/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import ssrPlugin from "vite-ssr-components/plugin";

export default defineConfig({
  plugins: [
    inertiaPages({ pagesDir: "src/pages", outFile: "src/pages.gen.ts", serverModule: "./index" }),
    react(),
    tailwindcss(),
    cloudflare(),
    ssrPlugin(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});

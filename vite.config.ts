import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // Previews load GSAP from the app itself (see previewDoc in
      // src/server/index.ts), so no third-party script is needed.
      name: "local-gsap",
      closeBundle() {
        const source = join(dirname(createRequire(import.meta.url).resolve("gsap/package.json")), "dist");
        const target = resolve("dist/vendor/gsap");
        mkdirSync(target, { recursive: true });
        for (const file of readdirSync(source)) {
          if (file.endsWith(".min.js")) cpSync(join(source, file), join(target, file));
        }
      },
    },
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});

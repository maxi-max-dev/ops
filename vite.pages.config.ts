import { defineConfig } from "vite";

const publicBase = process.env.PAIRDESK_PUBLIC_BASE ?? "/max-ops-demo/";

export default defineConfig({
  root: "github-pages",
  publicDir: "../public-submission",
  base: publicBase,
  build: {
    outDir: "../dist-pages",
    emptyOutDir: true,
  },
});

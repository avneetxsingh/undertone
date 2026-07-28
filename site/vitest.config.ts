import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", unstubEnvs: true },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});

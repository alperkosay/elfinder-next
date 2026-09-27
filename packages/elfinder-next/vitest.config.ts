import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The connector is filesystem- and Node-API-heavy; there is nothing to gain
    // from a DOM environment.
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Each test builds its own temporary volume, so files never collide, but
    // sharp is a native addon and several suites resize images at once. A modest
    // pool keeps that predictable on CI runners.
    maxConcurrency: 4,
  },
});

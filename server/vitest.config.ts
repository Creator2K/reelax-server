import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 集成测试要起真实 HTTP + 临时 SQLite，串行更稳
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

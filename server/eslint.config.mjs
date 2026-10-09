import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 本项目大量使用 `any` 与游戏接口的松散结构，但显式 any 必须是有意的
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // 空 catch 是有意为之（日志/清理路径不允许影响主流程）
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },
);

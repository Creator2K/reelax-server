import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // 视觉规范防线：禁止玻璃拟态与渐变主色（对标 LDC 风格）
    files: ["src/components/**/*.tsx", "src/pages/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/backdrop-blur/]",
          message: "视觉规范禁止玻璃拟态（backdrop-blur）：层次请用 border + bg-card/bg-muted 表达。",
        },
        {
          selector: "Literal[value=/(from|via)-[a-z]+-\\d00\\s+to-/]",
          message: "视觉规范禁止渐变主色。",
        },
      ],
    },
  },
);

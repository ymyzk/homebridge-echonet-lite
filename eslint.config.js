import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "homebridge-plugin-template/**", "test/**", "sample*.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "dot-notation": "error",
      eqeqeq: ["error", "smart"],
      curly: ["error", "all"],
      "prefer-arrow-callback": "warn",
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": ["error", { classes: false, enums: false }],
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
);

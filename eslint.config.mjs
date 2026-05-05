import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Legacy Node.js scripts (CommonJS require, not part of the Next.js app):
    "basil/**",
    // Standalone scripts — Node.js entry points, not React components:
    "scripts/**",
  ]),
  {
    // eslint-plugin-react-hooks v5 introduced three new strict rules that
    // are experimental and flag widely-used patterns.  Downgrade to warning
    // so they surface in CI output without blocking merges while the
    // codebase is migrated to the new patterns incrementally.
    rules: {
      // Flags Date.now(), new Date(), Math.random(), etc. in render.
      // Many components legitimately need current time for display purposes.
      "react-hooks/purity": "warn",
      // Flags setState() called synchronously at the top of useEffect.
      // This is a common and accepted pattern for hydration-safe state init.
      "react-hooks/set-state-in-effect": "warn",
      // Flags ref.current reads during render.
      // Some components use refs for non-DOM values accessed during render.
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;

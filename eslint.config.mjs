import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

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
    // Vercel build output (generated CJS launchers, not source files):
    ".vercel/**",
    // Legacy Node.js scripts (CommonJS require, not part of the Next.js app):
    "basil/**",
    // Standalone scripts — Node.js entry points, not React components:
    "scripts/**",
  ]),
  {
    // Explicitly register the plugin so the custom rules below resolve.
    // eslint-config-next bundles react-hooks but flat config requires explicit
    // plugin registration when overriding rules outside the preset object.
    plugins: { "react-hooks": reactHooks },
    rules: {
      // eslint-plugin-react-hooks v5 introduced three experimental rules that
      // flag widely-accepted patterns.  Turn them off — the codebase uses
      // Date.now() in render (display purposes), setState at the top of
      // useEffect (hydration-safe init), and refs during render (non-DOM refs).
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      // Dynamic user-content images (blob URLs, data URLs, AI-generated image
      // URLs) cannot use next/image — the rule requires configured domains or
      // static imports.  These are legitimate <img> uses.
      "@next/next/no-img-element": "off",
      // Suppress warnings for intentionally-unused variables prefixed with `_`.
      // This is the standard TypeScript ESLint convention for destructuring
      // out values you need to skip (e.g. `{ score: _score, ...rest }`).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;

import { createRequire } from "module";
import path from "path";
import { heroui } from "@heroui/react";

// Resolve the real (possibly nested) location of @heroui/theme so Tailwind can
// scan its component styles. npm often nests it under @heroui/react instead of
// hoisting to the top level, which is why a hard-coded ./node_modules path can
// silently match nothing and leave every HeroUI component unstyled.
const require = createRequire(import.meta.url);
const herouiThemeDir = path.dirname(
  require.resolve("@heroui/theme/package.json", {
    paths: [path.dirname(require.resolve("@heroui/react/package.json"))],
  })
);

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
    path.join(herouiThemeDir, "dist/**/*.{js,ts,jsx,tsx}"),
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "PingFang SC", "Microsoft YaHei", "sans-serif"],
      },
    },
  },
  darkMode: "class",
  plugins: [
    // Stock HeroUI palette (default blue primary) for both light and dark — this
    // gives the polished, official look out of the box.
    heroui({
      defaultRadius: "md",
    }),
  ],
};

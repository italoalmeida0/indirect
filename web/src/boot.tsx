/**
 * Build entry.
 *
 * The router lives in `index.tsx` and is imported by the route modules for
 * nothing but its types and the odd helper. Naming that file as the bundler
 * entry makes it both an input and a shared module, which the bundler reports
 * as "Multiple files share the same output path" once splitting is on. A
 * one-line entry keeps the router an ordinary module.
 */
import "./index";
import "../style.tailwindcss.css";

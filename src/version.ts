// Resolve tradekit's package.json version once. Extracted iter393 so both the
// `version` CLI command (admin.ts) and the web /api/status endpoint can include
// the version without duplicating the path-walking + JSON-parse logic.
//
// dist/{this file}.js sits AT THE TOP of dist/ (compiled from src/version.ts).
// Repo root is therefore ONE dir up — not two like admin.ts (which is at dist/cli/).
// First draft of this file used "../../" copied from admin.ts and resolved to the
// parent of the repo root, finding no package.json. Fixed to "..".

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

let cached: string | null = null;

export function tradekitVersion(): string {
  if (cached != null) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}

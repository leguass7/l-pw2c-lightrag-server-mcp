import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lê `version` do `package.json` na raiz do pacote (funciona a partir de `src/` ou `dist/`).
 */
export function readPackageJsonVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return typeof pkg.version === "string"
      ? pkg.version
      : /* v8 ignore next */ "0.0.0";
  } catch {
    /* v8 ignore next */
    return "0.0.0";
  }
}

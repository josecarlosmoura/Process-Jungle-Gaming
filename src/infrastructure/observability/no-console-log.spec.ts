import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Varre src/ inteiro (producao) - nunca test/, scripts/ nem node_modules - procurando
// "console.log(" literal. main.ts usa console.error so no catch de ultimo recurso do bootstrap
// (antes do proprio logger existir), nunca console.log - essa unica linha ja emite JSON, nao
// texto livre, e esta fora do que este teste proibe.
const SRC_ROOT = join(__dirname, "..", "..");

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("auditoria de console.log em codigo de producao", () => {
  test("nenhum arquivo de produção em src/ contém console.log(", () => {
    const offenders = listSourceFiles(SRC_ROOT)
      .filter((file) => readFileSync(file, "utf8").includes("console.log("))
      .map((file) => file.slice(SRC_ROOT.length + 1));

    expect(offenders).toEqual([]);
  });
});

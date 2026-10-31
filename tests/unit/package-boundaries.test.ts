import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// T04-01: the build (project references) already rejects imports of a package that is
// not referenced; this guards the external dependencies each package may not use.
const root = path.resolve(import.meta.dirname, "../..");

function imports(pkg: string): string[] {
  const dir = path.join(root, "packages", pkg, "src");
  const found: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      found.push(`${path.relative(root, file)} → ${match[1]}`);
    }
  }
  return found;
}

describe("workspace package boundaries", () => {
  it.each(["protocol", "ui-shared", "engine"])("%s does not use Ink or React", (pkg) => {
    expect(imports(pkg).filter((line) => / → (ink|react|react-dom)(\/|$)/.test(line))).toEqual([]);
  });

  it("ui-shared is Node-free and only depends on protocol", () => {
    expect(imports("ui-shared").filter((line) => !/ → (\.|#assentor\/protocol\/)/.test(line))).toEqual([]);
  });

  it("protocol does not import other workspace packages", () => {
    expect(imports("protocol").filter((line) => line.includes(" → #assentor/"))).toEqual([]);
  });
});

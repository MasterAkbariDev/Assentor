import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// T04-01: the build (project references) already rejects imports of a package that is
// not referenced; this guards what the build does not see.
const root = path.resolve(import.meta.dirname, "../..");
const PACKAGES = ["protocol", "ui-shared", "engine", "cli", "ui"];

function sources(pkg: string): string[] {
  const dir = path.join(root, "packages", pkg, "src");
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function imports(pkg: string): Array<{ file: string; spec: string; line: string }> {
  return sources(pkg).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => ({
      file,
      spec: match[1]!,
      line: `${path.relative(root, file)} → ${match[1]}`,
    })),
  );
}

const lines = (pkg: string, keep: (spec: string) => boolean) =>
  imports(pkg)
    .filter(({ spec }) => keep(spec))
    .map(({ line }) => line);

describe("workspace package boundaries", () => {
  it.each(["protocol", "ui-shared", "engine"])("%s does not use Ink or React", (pkg) => {
    expect(lines(pkg, (spec) => /^(ink|react|react-dom)(\/|$)/.test(spec))).toEqual([]);
  });

  it("ui-shared is Node-free and only depends on protocol", () => {
    expect(lines("ui-shared", (spec) => !/^(\.|#assentor\/protocol\/)/.test(spec))).toEqual([]);
  });

  it("protocol is Node-free and imports no other workspace package", () => {
    expect(lines("protocol", (spec) => !spec.startsWith(".") && spec !== "zod")).toEqual([]);
  });

  it.each(PACKAGES)("%s relative imports stay inside the package", (pkg) => {
    const own = path.join(root, "packages", pkg) + path.sep;
    const escaping = imports(pkg)
      .filter(({ file, spec }) => spec.startsWith(".") && !path.resolve(path.dirname(file), spec).startsWith(own))
      .map(({ line }) => line);
    expect(escaping).toEqual([]);
  });

  // engine and cli both compile into the root dist/, protocol and ui-shared into
  // dist/protocol and dist/ui-shared: a shared path would silently overwrite.
  it("engine and cli never emit to the same dist/ path", () => {
    const emitted = (pkg: string) => {
      const src = path.join(root, "packages", pkg, "src");
      return sources(pkg).map((file) => path.relative(src, file).split(path.sep).join("/").replace(/\.tsx?$/, ""));
    };
    const engine = new Set(emitted("engine"));
    const cli = emitted("cli");
    expect(cli.filter((file) => engine.has(file))).toEqual([]);
    const topLevel = [...engine, ...cli].map((file) => file.split("/")[0]);
    expect(topLevel.filter((dir) => dir === "protocol" || dir === "ui-shared")).toEqual([]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import example from "./gmailctl-example.ts";
import {
  anyFrom,
  anyOf,
  anyTo,
  buildConfig,
  labelRule,
  renderConfig,
  validateConfig,
  type GmailctlConfig,
} from "./gmailctl.ts";

describe("filter helpers", () => {
  test("anyOf flattens nested or nodes", () => {
    expect(anyOf(anyTo(["a@x.com"]), anyFrom(["y.com", "z.com"]))).toEqual({
      or: [{ to: "a@x.com" }, { from: "y.com" }, { from: "z.com" }],
    });
  });

  test("anyOf keeps compound nodes intact", () => {
    const both = { and: [{ from: "a" }, { to: "b" }] };
    expect(anyOf(both, { from: "c" })).toEqual({ or: [both, { from: "c" }] });
  });
});

describe("validateConfig", () => {
  test("accepts the example", () => {
    expect(validateConfig(example)).toEqual([]);
  });

  test("reports undeclared labels, empty nodes, and duplicates", () => {
    const bad: GmailctlConfig = {
      version: "v1alpha3",
      labels: [{ name: "a" }, { name: "a" }],
      rules: [labelRule("b", { or: [] })],
    };
    expect(validateConfig(bad)).toEqual([
      "duplicate label: a",
      "rules[0].filter: empty or",
      "rules[0]: undeclared label b",
    ]);
  });

  test("allows any label when labels are unmanaged", () => {
    const unmanaged: GmailctlConfig = {
      version: "v1alpha3",
      rules: [labelRule("existing-in-gmail", { from: "x@example.com" })],
    };
    expect(validateConfig(unmanaged)).toEqual([]);
  });
});

test("renderConfig emits a header and parseable JSON", () => {
  const out = renderConfig(example, "example.ts");
  const lines = out.split("\n");
  expect(lines[0]).toStartWith("// Generated from example.ts");
  expect(JSON.parse(lines.slice(2).join("\n"))).toEqual(example);
});

describe("buildConfig", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
    );
  });

  const helpers = JSON.stringify(join(import.meta.dir, "gmailctl.ts"));

  /** A temp dir holding a real config module and an output directory. */
  async function workspace(body: string) {
    const root = await mkdtemp(join(tmpdir(), "gmailctl-build-"));
    roots.push(root);
    const source = join(root, "config.ts");
    await writeFile(source, `import { labelRule } from ${helpers};\n${body}`);
    return { root, source, out: join(root, "out", "config.jsonnet") };
  }

  test("replaces an existing symlink instead of writing through it", async () => {
    const w = await workspace(`export default {
  version: "v1alpha3",
  labels: [{ name: "ops" }],
  rules: [labelRule("ops", { from: "billing.example.net" })],
};\n`);
    const target = join(w.root, "linked-source.jsonnet");
    await writeFile(target, "// keep me\n");
    await buildConfig(w.source, join(w.root, "out", "first.jsonnet"));
    await symlink(target, w.out);

    await buildConfig(w.source, w.out);

    expect((await lstat(w.out)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, "utf8")).toBe("// keep me\n");
    const rendered = await readFile(w.out, "utf8");
    expect(rendered).toStartWith(`// Generated from ${w.source}`);
    expect(JSON.parse(rendered.split("\n").slice(2).join("\n")).rules)
      .toEqual([{ filter: { from: "billing.example.net" },
        actions: { labels: ["ops"] } }]);
    expect((await readdir(join(w.root, "out"))).sort())
      .toEqual(["config.jsonnet", "first.jsonnet"]);
  });

  test("keeps the old output and lists problems for an invalid config",
    async () => {
      const w = await workspace(`export default {
  version: "v1alpha3",
  labels: [{ name: "ops" }],
  rules: [labelRule("missing", { or: [] })],
};\n`);
      await buildConfig(
        (await workspace(`export default { version: "v1alpha3",
  rules: [labelRule("any", { from: "x@example.com" })] };\n`)).source,
        w.out,
      );
      const before = await readFile(w.out, "utf8");

      const error = await buildConfig(w.source, w.out).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(`invalid config ${w.source}`);
      expect(error.message).toContain("rules[0].filter: empty or");
      expect(error.message).toContain("rules[0]: undeclared label missing");
      expect(await readFile(w.out, "utf8")).toBe(before);
      expect(await readdir(join(w.root, "out"))).toEqual(["config.jsonnet"]);
    });
});

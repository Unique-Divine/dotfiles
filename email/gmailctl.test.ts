import { describe, expect, test } from "bun:test";

import example from "./gmailctl-example.ts";
import {
  anyFrom,
  anyOf,
  anyTo,
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

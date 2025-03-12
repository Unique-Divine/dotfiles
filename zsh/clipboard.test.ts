import { test, expect, describe } from "bun:test";
import { bash } from "@uniquedivine/bash";

test("commands present: pbcopy, pbpaste", async () => {
  let out = await bash(`which pbcopy`);
  expect(out.stdout).not.toBeEmpty();
  expect(out.stderr).toBeEmpty();
  out = await bash(`which pbpaste`);
  expect(out.stdout).not.toBeEmpty();
  expect(out.stderr).toBeEmpty();
});

test("pbpaste correctly retrieves a single line without extra newlines", async () => {
  // Copy "one line output" to the clipboard (equivalent to pbcopy)
  await bash(`echo "one line output" | pbcopy`);
  const output = await bash("pbpaste");
  expect(output.stdout).toBe("one line output\n");
});

describe("pbpaste correctly retrieves a multiple lines", async () => {
  test("with trailing newlines", async () => {
    await bash(`printf "line0\nline1\n\n\n" | pbcopy`);
    const output = await bash("pbpaste");
    expect(output.stdout).toBe("line0\nline1\n\n\n");
  });
  test("without trailing newlines", async () => {
    await bash(`printf "line0\nline1" | pbcopy`);
    let output = await bash("pbpaste");
    expect(output.stdout).toBe("line0\nline1");
  });
});

describe("echo suite", async () => {
  const cases: { given: string; want: string }[] = [
    { given: "sanity check", want: "sanity check" },
    { given: "HJK 日本語", want: "HJK 日本語" },
    {
      given: `この職場は、経験よりも腕を優先する考え方だ。
職場 (しょくば)
`,
      want: `この職場は、経験よりも腕を優先する考え方だ。
職場 (しょくば)
`,
    },
  ];
  for (let { given, want } of cases) {
    test(`input: "${given}", want: "${want}"`, async () => {
      await bash(`printf "${given}" | pbcopy`);
      const out = await bash("pbpaste");
      expect(out.stdout).toBe(want);
    });
  }
});

import type { Subprocess } from "bun";
import { test, expect, describe } from "bun:test";

interface BashOut {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const bash = async (cmd: string): Promise<BashOut> => {
  const rawOut: Subprocess = Bun.spawn(["bash", "-c", cmd]);
  const { stdout, stderr, exitCode } = rawOut;
  return {
    stdout: await new Response(
      typeof stdout === "number" ? stdout.toString() : stdout,
    ).text(),
    stderr: await new Response(
      typeof stderr === "number" ? stderr.toString() : stderr,
    ).text(),
    exitCode,
  };
};

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

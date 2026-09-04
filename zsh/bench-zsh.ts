import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type BenchmarkMode = "init" | "prompt"

type Options = {
  json: boolean
  login: boolean
  mode: BenchmarkMode
  runs: number
  shell: string
  timeoutMs: number
  warmups: number
}

type Summary = {
  maxMs: number
  meanMs: number
  medianMs: number
  minMs: number
  p95Ms: number
}

const defaultOptions: Options = {
  json: false,
  login: false,
  mode: "init",
  runs: 10,
  shell: "zsh",
  timeoutMs: 30_000,
  warmups: 2,
}

const usage = `Usage: just bench-zsh [options]

Measures fresh interactive Zsh startup. The default mode measures work before
Turbo plugins run. Prompt mode uses a PTY and stops when ZLE accepts input.

Options:
  --runs N           Measured sequential runs (default: ${defaultOptions.runs})
  --warmups N        Unreported warmup runs (default: ${defaultOptions.warmups})
  --shell PATH       Zsh executable (default: ${defaultOptions.shell})
  --mode MODE        init or prompt (default: ${defaultOptions.mode})
  --timeout-ms N     Per-run timeout (default: ${defaultOptions.timeoutMs})
  --login            Include login startup files
  --json             Emit a machine-readable report
  --help             Show this help
`

const parseNonNegativeInteger = (flag: string, value: string | undefined) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`)
  }
  return parsed
}

const parsePositiveInteger = (flag: string, value: string | undefined) => {
  const parsed = parseNonNegativeInteger(flag, value)
  if (parsed === 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

export const parseArgs = (argv: string[]): Options => {
  const options = { ...defaultOptions }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case "--runs":
        options.runs = parsePositiveInteger(arg, argv[++index])
        break
      case "--warmups":
        options.warmups = parseNonNegativeInteger(arg, argv[++index])
        break
      case "--shell":
        options.shell = argv[++index] ?? ""
        if (!options.shell) throw new Error(`${arg} requires a path`)
        break
      case "--mode": {
        const mode = argv[++index]
        if (mode !== "init" && mode !== "prompt") {
          throw new Error(`${arg} requires init or prompt`)
        }
        options.mode = mode
        break
      }
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(arg, argv[++index])
        break
      case "--login":
        options.login = true
        break
      case "--json":
        options.json = true
        break
      case "--help":
        console.info(usage)
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage}`)
    }
  }

  return options
}

const percentile = (samples: number[], fraction: number): number => {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

export const summarize = (samples: number[]): Summary => ({
  maxMs: Math.max(...samples),
  meanMs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
  medianMs: percentile(samples, 0.5),
  minMs: Math.min(...samples),
  p95Ms: percentile(samples, 0.95),
})

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\\"'\\\"'")}'`

const sourceIfReadable = (path: string): string =>
  `[[ -r ${shellQuote(path)} ]] && source ${shellQuote(path)}`

export const buildPromptZshrc = (realZdotdir: string, marker: string): string =>
  [
    sourceIfReadable(join(realZdotdir, ".zshrc")),
    "typeset -g _zsh_benchmark_prompt_seen=0",
    "if (( ${+widgets[zle-line-init]} )); then",
    "  zle -A zle-line-init _zsh_benchmark_previous_line_init",
    "fi",
    "_zsh_benchmark_line_init() {",
    "  (( _zsh_benchmark_prompt_seen )) && return 0",
    "  _zsh_benchmark_prompt_seen=1",
    "  if (( ${+widgets[_zsh_benchmark_previous_line_init]} )); then",
    "    zle _zsh_benchmark_previous_line_init",
    "  fi",
    `  print -r -- ${shellQuote(marker)}`,
    "}",
    "zle -N zle-line-init _zsh_benchmark_line_init",
  ].join("\n")

const buildStartupFile = (realZdotdir: string, name: string): string =>
  sourceIfReadable(join(realZdotdir, name))

const waitForMarker = async (
  stream: ReadableStream<Uint8Array>,
  marker: string,
): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`Zsh exited before displaying ${marker}`)
    output += decoder.decode(value, { stream: true })
    if (output.includes(marker)) return
    output = output.slice(-marker.length)
  }
}

const runInitBenchmark = async (options: Options): Promise<number> => {
  const args = [options.shell, options.login ? "-lic" : "-ic", "exit"]
  const startedAt = performance.now()
  const child = Bun.spawn(args, {
    stdin: "inherit",
    stdout: "ignore",
    stderr: "pipe",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeoutMs)

  try {
    const exitCode = await child.exited
    const stderr = await new Response(child.stderr).text()
    if (timedOut) {
      throw new Error(`Zsh timed out after ${options.timeoutMs}ms`)
    }
    if (exitCode !== 0) {
      throw new Error(
        `Zsh exited with code ${exitCode}: ${stderr.trim() || "no stderr"}`,
      )
    }
    return performance.now() - startedAt
  } finally {
    clearTimeout(timeout)
  }
}

const runPromptBenchmark = async (options: Options): Promise<number> => {
  const realZdotdir = Bun.env.ZDOTDIR ?? Bun.env.HOME
  if (!realZdotdir) throw new Error("HOME or ZDOTDIR must be set")

  const directory = await mkdtemp(join(tmpdir(), "dotfiles-zsh-bench-"))
  const marker = `__DOTFILES_ZSH_READY_${crypto.randomUUID()}__`
  try {
    await Promise.all([
      writeFile(
        join(directory, ".zshenv"),
        buildStartupFile(realZdotdir, ".zshenv"),
      ),
      writeFile(
        join(directory, ".zprofile"),
        buildStartupFile(realZdotdir, ".zprofile"),
      ),
      writeFile(
        join(directory, ".zlogin"),
        buildStartupFile(realZdotdir, ".zlogin"),
      ),
      writeFile(
        join(directory, ".zshrc"),
        buildPromptZshrc(realZdotdir, marker),
      ),
    ])
    const startedAt = performance.now()
    const child = Bun.spawn(
      [
        "script",
        "-qefc",
        `${shellQuote(options.shell)} ${options.login ? "-li" : "-i"}`,
        "/dev/null",
      ],
      {
        env: { ...Bun.env, ZDOTDIR: directory },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdin = child.stdin
    if (typeof stdin === "number") {
      child.kill()
      await child.exited
      throw new Error("PTY benchmark stdin is not writable")
    }

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs)

    try {
      await waitForMarker(child.stdout, marker)
      if (timedOut)
        throw new Error(`Zsh timed out after ${options.timeoutMs}ms`)
      const elapsedMs = performance.now() - startedAt
      stdin.write("exit\n")
      await stdin.flush()
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ])
      if (exitCode !== 0) {
        throw new Error(
          `Zsh exited with code ${exitCode}: ${stderr.trim() || "no stderr"}`,
        )
      }
      return elapsedMs
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

const runBenchmark = (options: Options): Promise<number> =>
  options.mode === "init"
    ? runInitBenchmark(options)
    : runPromptBenchmark(options)

const formatMs = (value: number) => `${value.toFixed(2)} ms`

export const main = async (argv: string[]): Promise<void> => {
  const options = parseArgs(argv)
  for (let index = 0; index < options.warmups; index += 1) {
    await runBenchmark(options)
  }

  const samples: number[] = []
  for (let index = 0; index < options.runs; index += 1) {
    samples.push(await runBenchmark(options))
  }
  const summary = summarize(samples)

  if (options.json) {
    console.info(JSON.stringify({ options, samplesMs: samples, summary }))
    return
  }

  const description =
    options.mode === "init"
      ? "synchronous startup and shutdown before Turbo callbacks"
      : "time until ZLE accepts input in a pseudo-terminal"
  console.info(`Mode: ${options.mode}, ${description}`)
  console.info(`Warmups: ${options.warmups}; measured runs: ${options.runs}`)
  console.info(`Mean:   ${formatMs(summary.meanMs)}`)
  console.info(`Median: ${formatMs(summary.medianMs)}`)
  console.info(`P95:    ${formatMs(summary.p95Ms)}`)
  console.info(
    `Range:  ${formatMs(summary.minMs)} - ${formatMs(summary.maxMs)}`,
  )
  console.info(`Samples: ${samples.map(formatMs).join(", ")}`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

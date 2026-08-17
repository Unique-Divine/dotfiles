type Options = {
  json: boolean
  login: boolean
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
  runs: 10,
  shell: "zsh",
  timeoutMs: 30_000,
  warmups: 2,
}

const usage = `Usage: just bench-zsh [options]

Measures the full lifecycle of fresh interactive Zsh subprocesses. It includes
startup and shutdown time; it does not by itself measure when a prompt appears.

Options:
  --runs N           Measured sequential runs (default: ${defaultOptions.runs})
  --warmups N        Unreported warmup runs (default: ${defaultOptions.warmups})
  --shell PATH       Zsh executable (default: ${defaultOptions.shell})
  --timeout-ms N     Per-run timeout (default: ${defaultOptions.timeoutMs})
  --login            Run login shells with zsh -lic exit
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

const runShell = async (options: Options): Promise<number> => {
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

const formatMs = (value: number) => `${value.toFixed(2)} ms`

export const main = async (argv: string[]): Promise<void> => {
  const options = parseArgs(argv)
  for (let index = 0; index < options.warmups; index += 1) {
    await runShell(options)
  }

  const samples: number[] = []
  for (let index = 0; index < options.runs; index += 1) {
    samples.push(await runShell(options))
  }
  const summary = summarize(samples)

  if (options.json) {
    console.info(JSON.stringify({ options, samplesMs: samples, summary }))
    return
  }

  console.info(`Command: ${options.shell} ${options.login ? "-lic" : "-ic"} exit`)
  console.info(`Warmups: ${options.warmups}; measured runs: ${options.runs}`)
  console.info(`Mean:   ${formatMs(summary.meanMs)}`)
  console.info(`Median: ${formatMs(summary.medianMs)}`)
  console.info(`P95:    ${formatMs(summary.p95Ms)}`)
  console.info(`Range:  ${formatMs(summary.minMs)} - ${formatMs(summary.maxMs)}`)
  console.info(`Samples: ${samples.map(formatMs).join(", ")}`)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

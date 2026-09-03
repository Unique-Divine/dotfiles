interface BenchmarkOptions {
  iterations: number
  payloadBytes: number
  warmups: number
}

export interface TimingSummary {
  label: string
  iterations: number
  minMs: number
  medianMs: number
  meanMs: number
  p95Ms: number
  maxMs: number
}

interface BenchmarkCase {
  label: string
  operation: () => Promise<void>
}

interface PersistentBenchmark {
  firstRequestMs: number
  startupMs: number
  summary: TimingSummary
}

const DEFAULT_OPTIONS: BenchmarkOptions = {
  iterations: 10,
  payloadBytes: 128,
  warmups: 2,
}

const parsePositiveInteger = (value: string, flag: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

export const parseOptions = (args: string[]): BenchmarkOptions => {
  const options = { ...DEFAULT_OPTIONS }

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    if (flag === "--iters") {
      options.iterations = parsePositiveInteger(value, flag)
    } else if (flag === "--warmups") {
      options.warmups = parsePositiveInteger(value, flag)
    } else if (flag === "--in-bz") {
      options.payloadBytes = parsePositiveInteger(value, flag)
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
    index += 1
  }

  return options
}

const percentile = (sorted: number[], ratio: number): number => {
  const index = Math.ceil(sorted.length * ratio) - 1
  return sorted[Math.max(0, index)]
}

export const summarizeTimings = (
  label: string,
  samples: number[],
): TimingSummary => {
  if (samples.length === 0) {
    throw new Error("Cannot summarize an empty sample set")
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const total = sorted.reduce((sum, sample) => sum + sample, 0)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle]

  return {
    label,
    iterations: sorted.length,
    minMs: sorted[0],
    medianMs: median,
    meanMs: total / sorted.length,
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  }
}

export const decodeClipboardResponse = (encoded: string): string =>
  Buffer.from(encoded, "base64").toString("utf8")

export const buildPersistentPowerShellScript = (): string =>
  [
    `$ErrorActionPreference = 'Stop'`,
    `[Console]::Out.WriteLine('READY')`,
    `[Console]::Out.Flush()`,
    `while (($line = [Console]::In.ReadLine()) -ne $null) {`,
    `if ($line -eq 'PASTE') {`,
    `$text = Get-Clipboard -Raw`,
    `if ($null -eq $text) { $text = '' }`,
    `$bytes = [Text.Encoding]::UTF8.GetBytes([string]$text)`,
    `[Console]::Out.WriteLine([Convert]::ToBase64String($bytes))`,
    `[Console]::Out.Flush()`,
    `} elseif ($line -eq 'QUIT') { break }`,
    `}`,
  ].join("; ")

class LineReader {
  private buffer = ""
  private readonly decoder = new TextDecoder()
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  async readLine(): Promise<string> {
    while (!this.buffer.includes("\n")) {
      const { done, value } = await this.reader.read()
      if (done) {
        throw new Error(
          "Persistent PowerShell closed before returning a complete line",
        )
      }
      this.buffer += this.decoder.decode(value, { stream: true })
    }

    const newline = this.buffer.indexOf("\n")
    const line = this.buffer.slice(0, newline).replace(/\r$/, "")
    this.buffer = this.buffer.slice(newline + 1)
    return line
  }
}

const runCommand = async (
  command: string[],
  input?: string,
): Promise<string> => {
  const process = Bun.spawn(command, {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with ${exitCode}: ${stderr.trim()}`)
  }
  return stdout
}

const powershellArgs = (script: string): string[] => [
  "powershell.exe",
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  script,
]

const wslClipboardArgs = (operation: "copy" | "paste" | "stop"): string[] => [
  Bun.env.WSL_CLIPBOARD_BIN ?? "wsl-clipboard",
  operation,
]

const measure = async (
  benchmark: BenchmarkCase,
  options: BenchmarkOptions,
): Promise<TimingSummary> => {
  for (let index = 0; index < options.warmups; index += 1) {
    await benchmark.operation()
  }

  const samples: number[] = []
  for (let index = 0; index < options.iterations; index += 1) {
    const startedAt = performance.now()
    await benchmark.operation()
    samples.push(performance.now() - startedAt)
  }
  return summarizeTimings(benchmark.label, samples)
}

const measureWarmPowerShell = async (
  options: BenchmarkOptions,
): Promise<TimingSummary> => {
  const script = [
    `for ($i = 0; $i -lt ${options.warmups}; $i++) {`,
    `$null = Get-Clipboard -Raw`,
    `}`,
    `$samples = @()`,
    `for ($i = 0; $i -lt ${options.iterations}; $i++) {`,
    `$sw = [Diagnostics.Stopwatch]::StartNew()`,
    `$null = Get-Clipboard -Raw`,
    `$sw.Stop()`,
    `$samples += $sw.Elapsed.TotalMilliseconds`,
    `}`,
    `[Console]::Out.Write(($samples | ConvertTo-Json -Compress))`,
  ].join("; ")
  const output = await runCommand(powershellArgs(script))
  const parsed: number | number[] = JSON.parse(output)
  const samples = Array.isArray(parsed) ? parsed : [parsed]
  return summarizeTimings("PowerShell warm cmdlet", samples)
}

const measurePersistentPowerShell = async (
  payload: string,
  options: BenchmarkOptions,
): Promise<PersistentBenchmark> => {
  const startedAt = performance.now()
  const process = Bun.spawn(powershellArgs(buildPersistentPowerShellScript()), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdin = process.stdin
  if (typeof stdin === "number") {
    process.kill()
    await process.exited
    throw new Error("Persistent PowerShell stdin is not writable")
  }
  const lines = new LineReader(process.stdout)

  try {
    const greeting = await lines.readLine()
    if (greeting !== "READY") {
      throw new Error(`Unexpected persistent PowerShell greeting: ${greeting}`)
    }
    const startupMs = performance.now() - startedAt
    const request = async (): Promise<void> => {
      stdin.write("PASTE\n")
      stdin.flush()
      const actual = decodeClipboardResponse(await lines.readLine())
      if (actual !== payload) {
        throw new Error(
          "Persistent PowerShell returned different clipboard text",
        )
      }
    }

    const firstRequestAt = performance.now()
    await request()
    const firstRequestMs = performance.now() - firstRequestAt
    const summary = await measure(
      {
        label: "PowerShell persistent",
        operation: request,
      },
      options,
    )
    return {
      firstRequestMs,
      startupMs,
      summary,
    }
  } finally {
    if (process.exitCode === null) {
      stdin.write("QUIT\n")
    }
    stdin.end()
    const exitCode = await process.exited
    if (exitCode !== 0) {
      const stderr = await new Response(process.stderr).text()
      throw new Error(
        `Persistent PowerShell exited with ${exitCode}: ${stderr.trim()}`,
      )
    }
  }
}

const formatMs = (value: number): string =>
  Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1)

const printResults = (results: TimingSummary[]): void => {
  console.table(
    results.map((result) => ({
      operation: result.label,
      runs: result.iterations,
      min_ms: formatMs(result.minMs),
      median_ms: formatMs(result.medianMs),
      mean_ms: formatMs(result.meanMs),
      p95_ms: formatMs(result.p95Ms),
      max_ms: formatMs(result.maxMs),
    })),
  )

  const byLabel = new Map(results.map((result) => [result.label, result]))
  const legacyCopy = byLabel.get("legacy-pbcopy")
  const clip = byLabel.get("clip.exe direct")
  const legacyPaste = byLabel.get("legacy-pbpaste")
  const bridgeCopy = byLabel.get("pbcopy (symlink)")
  const bridgePaste = byLabel.get("pbpaste (symlink)")
  const powershell = byLabel.get("PowerShell direct")
  const noProfile = byLabel.get("PowerShell no-profile")
  const warm = byLabel.get("PowerShell warm cmdlet")
  const persistent = byLabel.get("PowerShell persistent")
  const legacyRoundTrip = byLabel.get("legacy-pbcopy + legacy-pbpaste")
  const bridgeRoundTrip = byLabel.get("pbcopy + pbpaste (symlink)")

  if (
    legacyCopy &&
    clip &&
    legacyPaste &&
    powershell &&
    noProfile &&
    warm &&
    persistent &&
    legacyRoundTrip
  ) {
    const copyWrapper = legacyCopy.medianMs - clip.medianMs
    const pasteWrapper = legacyPaste.medianMs - powershell.medianMs
    const roundTripExtra =
      legacyRoundTrip.medianMs - legacyCopy.medianMs - legacyPaste.medianMs
    const coldStartup = noProfile.medianMs - warm.medianMs
    const persistentOverhead = persistent.medianMs - warm.medianMs
    const persistentSpeedup = noProfile.medianMs / persistent.medianMs

    console.log("\nMedian deltas (approximate; subprocess timings are noisy):")
    console.log(`  legacy pbcopy shell wrapper: ${formatMs(copyWrapper)} ms`)
    console.log(`  legacy pbpaste shell pipeline: ${formatMs(pasteWrapper)} ms`)
    console.log(`  round-trip coordination: ${formatMs(roundTripExtra)} ms`)
    console.log(`  PowerShell cold startup: ${formatMs(coldStartup)} ms`)
    console.log(
      `  persistent protocol overhead: ${formatMs(persistentOverhead)} ms`,
    )
    console.log(`  persistent paste speedup: ${persistentSpeedup.toFixed(1)}x`)
  }

  if (
    bridgeCopy &&
    bridgePaste &&
    bridgeRoundTrip &&
    legacyCopy &&
    legacyPaste &&
    legacyRoundTrip
  ) {
    console.log("\nPersistent bridge median speedups:")
    console.log(
      `  copy: ${(legacyCopy.medianMs / bridgeCopy.medianMs).toFixed(1)}x`,
    )
    console.log(
      `  paste: ${(legacyPaste.medianMs / bridgePaste.medianMs).toFixed(1)}x`,
    )
    console.log(
      `  round trip: ${(legacyRoundTrip.medianMs / bridgeRoundTrip.medianMs).toFixed(1)}x`,
    )
  }
}

const main = async (): Promise<void> => {
  const options = parseOptions(Bun.argv.slice(2))
  const payload = "x".repeat(options.payloadBytes)
  const powershellCommand = ["powershell.exe", "(Get-Clipboard).TrimEnd()"]
  const useRustBridge = Bun.env.WSL_CLIPBOARD_BIN !== undefined

  await runCommand(["legacy-pbcopy"], payload)
  if (useRustBridge) {
    await runCommand(wslClipboardArgs("copy"), payload)
  }
  const benchmarks: BenchmarkCase[] = [
    {
      label: "process baseline",
      operation: async () => {
        await runCommand(["/bin/true"])
      },
    },
    {
      label: "clip.exe direct",
      operation: async () => {
        await runCommand(["clip.exe"], payload)
      },
    },
    {
      label: "legacy-pbcopy",
      operation: async () => {
        await runCommand(["legacy-pbcopy"], payload)
      },
    },
    {
      label: "PowerShell direct",
      operation: async () => {
        await runCommand(powershellCommand)
      },
    },
    {
      label: "PowerShell no-profile",
      operation: async () => {
        await runCommand(powershellArgs("(Get-Clipboard).TrimEnd()"))
      },
    },
    {
      label: "legacy-pbpaste",
      operation: async () => {
        await runCommand(["legacy-pbpaste"])
      },
    },
    {
      label: "legacy-pbcopy + legacy-pbpaste",
      operation: async () => {
        await runCommand(["legacy-pbcopy"], payload)
        const pasted = await runCommand(["legacy-pbpaste"])
        if (pasted !== payload) {
          throw new Error("Legacy clipboard round trip returned different text")
        }
      },
    },
    {
      label: "pbcopy (symlink)",
      operation: async () => {
        await runCommand(["pbcopy"], payload)
      },
    },
    {
      label: "pbpaste (symlink)",
      operation: async () => {
        await runCommand(["pbpaste"])
      },
    },
    {
      label: "pbcopy + pbpaste (symlink)",
      operation: async () => {
        await runCommand(["pbcopy"], payload)
        const pasted = await runCommand(["pbpaste"])
        if (pasted !== payload) {
          throw new Error(
            "Persistent clipboard round trip returned different text",
          )
        }
      },
    },
  ]
  if (useRustBridge) {
    benchmarks.push(
      {
        label: "wsl-clipboard copy",
        operation: async () => {
          await runCommand(wslClipboardArgs("copy"), payload)
        },
      },
      {
        label: "wsl-clipboard paste",
        operation: async () => {
          await runCommand(wslClipboardArgs("paste"))
        },
      },
      {
        label: "wsl-clipboard copy + paste",
        operation: async () => {
          await runCommand(wslClipboardArgs("copy"), payload)
          const pasted = await runCommand(wslClipboardArgs("paste"))
          if (pasted !== payload) {
            throw new Error(
              "Persistent clipboard round trip returned different text",
            )
          }
        },
      },
    )
  }

  console.log(
    `Clipboard benchmark: ${options.iterations} runs, ` +
      `${options.warmups} warmups, ${options.payloadBytes} bytes`,
  )
  try {
    const results: TimingSummary[] = []
    for (const benchmark of benchmarks) {
      results.push(await measure(benchmark, options))
    }
    results.push(await measureWarmPowerShell(options))
    const persistent = await measurePersistentPowerShell(payload, options)
    results.push(persistent.summary)
    console.log(
      `Persistent PowerShell startup: ${formatMs(persistent.startupMs)} ms; ` +
        `first request: ${formatMs(persistent.firstRequestMs)} ms`,
    )
    printResults(results)
  } finally {
    if (useRustBridge) {
      try {
        await runCommand(wslClipboardArgs("stop"))
      } catch (error) {
        console.error(`Could not stop persistent clipboard bridge: ${error}`)
      }
    }
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Clipboard benchmark failed: ${message}`)
    process.exitCode = 1
  }
}

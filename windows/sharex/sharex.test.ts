import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const sharexDir = import.meta.dir
const powershellTestPath = join(
  sharexDir,
  "tests",
  "Run-ShareXAudioTests.ps1",
)

const isWsl = (() => {
  if (process.platform !== "linux") {
    return false
  }

  if (process.env.WSL_DISTRO_NAME) {
    return true
  }

  try {
    return readFileSync("/proc/version", "utf8")
      .toLowerCase()
      .includes("microsoft")
  } catch {
    return false
  }
})()

const hasCommand = (command: string): boolean => {
  if (!isWsl) {
    return false
  }

  const result = Bun.spawnSync(["which", command], {
    stderr: "pipe",
    stdout: "pipe",
  })
  return result.exitCode === 0
}

const canRunShareXTests =
  isWsl && hasCommand("powershell.exe") && hasCommand("wslpath")

const sharexDescribe = canRunShareXTests ? describe : describe.skip

const toWindowsPath = (path: string): string => {
  const result = Bun.spawnSync(["wslpath", "-w", path], {
    stderr: "pipe",
    stdout: "pipe",
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }

  return result.stdout.toString().trim()
}

const runPowerShellFile = (
  path: string,
  args: string[] = [],
): ReturnType<typeof Bun.spawnSync> => {
  return Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      toWindowsPath(path),
      ...args,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  )
}

const expectSuccessfulPowerShellJson = (path: string) => {
  const result = runPowerShellFile(path)
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")

  const envelope = JSON.parse(result.stdout.toString()) as {
    Ok: boolean
  }
  expect(envelope.Ok).toBe(true)
}

sharexDescribe("ShareX audio scripts", () => {
  test("passes the PowerShell unit suite", () => {
    const result = runPowerShellFile(powershellTestPath)

    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe("")
    expect(result.stdout.toString()).toContain("PASS: 17 ShareX audio tests")
  })

  test("returns structured discovery results", () => {
    expectSuccessfulPowerShellJson(
      join(sharexDir, "Get-ShareXFFmpeg.ps1"),
    )
    expectSuccessfulPowerShellJson(
      join(sharexDir, "Get-DefaultRecordingDevice.ps1"),
    )
    expectSuccessfulPowerShellJson(
      join(sharexDir, "Get-DirectShowDevices.ps1"),
    )

    const commandResult = runPowerShellFile(
      join(sharexDir, "New-ShareXAudioCommand.ps1"),
    )
    expect(commandResult.exitCode).toBe(0)
    expect(commandResult.stderr.toString()).toBe("")

    const commandEnvelope = JSON.parse(commandResult.stdout.toString()) as {
      Data: { Command: string }
      Ok: boolean
    }
    expect(commandEnvelope.Ok).toBe(true)
    expect(commandEnvelope.Data.Command).toContain("amix=inputs=2")
    expect(commandEnvelope.Data.Command).toContain("$output$")
  }, 30_000)
})

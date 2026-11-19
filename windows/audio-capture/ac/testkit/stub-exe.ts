/**
 * Test stand-in for wslpath, cmd.exe, powershell.exe, explorer.exe,
 * clip.exe, and fzf. testkit.ts puts a wrapper per name first on PATH. Each
 * call appends {name, argv, stdin} to $AC_STUB_LOG and prints canned output
 * for the fake C: drive at $AC_STUB_C.
 *
 * Usage: bun stub-exe.ts <name> [args...]
 */
import { appendFileSync } from "node:fs"

const [name = "", ...argv] = process.argv.slice(2)
const env = process.env
const cRoot = env.AC_STUB_C ?? "/nonexistent"
const readsStdin = name === "clip.exe" || name === "fzf"
const stdin = readsStdin ? await Bun.stdin.text() : null

if (env.AC_STUB_LOG) {
  appendFileSync(env.AC_STUB_LOG, JSON.stringify({ name, argv, stdin }) + "\n")
}

const write = (text: string) => process.stdout.write(text)

const winToWsl = (path: string): string | null => {
  const match = /^[cC]:\\?(.*)$/.exec(path)
  if (!match) return null
  const rest = (match[1] ?? "").replaceAll("\\", "/")
  return rest === "" ? cRoot : `${cRoot}/${rest}`
}

const wslToWin = (path: string): string | null => {
  if (path !== cRoot && !path.startsWith(cRoot + "/")) return null
  return "C:\\" + path.slice(cRoot.length + 1).replaceAll("/", "\\")
}

switch (name) {
  case "cmd.exe":
    write("C:\\Users\\test\r\n")
    break
  case "powershell.exe":
    write(JSON.stringify({
      MyDocuments: "C:\\Users\\test\\Documents",
      MyMusic: "C:\\Users\\test\\Music",
      MyVideos: "C:\\Users\\test\\Videos",
      DesktopDirectory: "C:\\Users\\test\\Desktop",
      UserProfile: "C:\\Users\\test",
      ApplicationData: "C:\\Users\\test\\AppData\\Roaming",
      LocalApplicationData: "C:\\Users\\test\\AppData\\Local",
    }) + "\r\n")
    break
  case "wslpath": {
    const [flag, path = ""] = argv
    const out = flag === "-u" ? winToWsl(path) : wslToWin(path)
    if (out === null) {
      process.stderr.write(`wslpath: ${path}: not on the fake drive\n`)
      process.exit(1)
    }
    write(out + "\n")
    break
  }
  case "explorer.exe":
    // The real Explorer exits 1 after handing off to a running Explorer.
    process.exit(1)
  case "clip.exe":
    break
  case "fzf":
    write(env.AC_STUB_FZF_OUT ?? "")
    process.exit(Number(env.AC_STUB_FZF_CODE ?? "0"))
  default:
    process.stderr.write(`stub-exe: unknown program ${name}\n`)
    process.exit(2)
}

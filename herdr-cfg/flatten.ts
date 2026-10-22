import { bash } from "@uniquedivine/bash"

export interface Pane {
  pane_id: string
  tab_id: string
  workspace_id: string
  terminal_id: string
  agent?: string
  focused: boolean
}

export interface FlattenPlan {
  moves: Pane[]
  nonAgentPanes: Pane[]
}

export const usage = `Usage: just herdr-flatten [--run]

Preview moves in the calling pane's workspace. With --run, keep one agent
per existing tab and move extra agents into new tabs without taking focus.
Non-agent panes are reported and left alone. Requires HERDR_ENV=1.`

export function parseArgs(args: string[]): "preview" | "run" | "help" {
  if (args.length === 0) return "preview"
  if (args.length === 1 && args[0] === "--run") return "run"
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    return "help"
  }
  throw new Error(usage)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Herdr response: expected an object")
  }
  return value as Record<string, unknown>
}

export function parsePane(value: unknown): Pane {
  const pane = asRecord(value)
  for (const key of ["pane_id", "tab_id", "workspace_id", "terminal_id"]) {
    if (typeof pane[key] !== "string" || !pane[key]) {
      throw new Error(`Invalid Herdr pane: missing ${key}`)
    }
  }
  if (typeof pane.focused !== "boolean") {
    throw new Error("Invalid Herdr pane: missing focused flag")
  }
  if (pane.agent != null && (typeof pane.agent !== "string" || !pane.agent)) {
    throw new Error("Invalid Herdr pane: expected an agent name")
  }
  return {
    pane_id: pane.pane_id as string,
    tab_id: pane.tab_id as string,
    workspace_id: pane.workspace_id as string,
    terminal_id: pane.terminal_id as string,
    agent: pane.agent == null ? undefined : (pane.agent as string),
    focused: pane.focused,
  }
}

export function parsePaneList(result: unknown): Pane[] {
  const { panes } = asRecord(result)
  if (!Array.isArray(panes)) {
    throw new Error("Invalid Herdr response: expected panes")
  }
  const parsed = panes.map(parsePane)
  if (new Set(parsed.map((pane) => pane.pane_id)).size !== parsed.length) {
    throw new Error("Invalid Herdr response: duplicate pane IDs")
  }
  return parsed
}

export function planFlatten(panes: Pane[], workspaceId: string): FlattenPlan {
  const tabs = new Map<string, Pane[]>()
  const nonAgentPanes: Pane[] = []
  for (const pane of panes) {
    if (pane.workspace_id !== workspaceId) continue
    if (!pane.agent) {
      nonAgentPanes.push(pane)
      continue
    }
    const agents = tabs.get(pane.tab_id) ?? []
    agents.push(pane)
    tabs.set(pane.tab_id, agents)
  }
  const moves: Pane[] = []
  for (const agents of tabs.values()) {
    const keep = agents.find((pane) => pane.focused) ?? agents[0]!
    moves.push(...agents.filter((pane) => pane !== keep))
  }
  return { moves, nonAgentPanes }
}

export function quoteArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function herdr(args: string[]): Promise<Record<string, unknown>> {
  const command = ["herdr", ...args].map(quoteArg).join(" ")
  // The bash package inherits stderr; redirect it to capture API failures.
  const output = await bash(`${command} 2>&1`)
  if (output.exitCode !== 0) {
    throw new Error(
      output.stderr.trim() ||
        output.stdout.trim() ||
        `herdr exited with status ${output.exitCode}`,
    )
  }
  return asRecord(asRecord(JSON.parse(output.stdout)).result)
}

async function listPanes(workspaceId: string): Promise<Pane[]> {
  return parsePaneList(
    await herdr(["pane", "list", "--workspace", workspaceId]),
  )
}

export async function main(args: string[]): Promise<void> {
  const mode = parseArgs(args)
  if (mode === "help") {
    console.log(usage)
    return
  }
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Run herdr-flatten inside a Herdr-managed pane")
  }
  const caller = parsePane((await herdr(["pane", "current", "--current"])).pane)
  const workspaceId = caller.workspace_id
  const plan = planFlatten(await listPanes(workspaceId), workspaceId)
  console.log(`Workspace ${workspaceId}: ${plan.moves.length} planned move(s).`)
  for (const pane of plan.moves) {
    console.log(`  ${pane.pane_id} (${pane.agent}): ${pane.tab_id} -> new tab`)
  }
  if (mode === "run") {
    for (const pane of plan.moves) {
      const latest = await listPanes(workspaceId)
      const current = latest.find((item) => item.pane_id === pane.pane_id)
      if (
        !current ||
        current.terminal_id !== pane.terminal_id ||
        current.agent !== pane.agent ||
        current.tab_id !== pane.tab_id
      ) {
        throw new Error(`Pane ${pane.pane_id} changed; rerun to replan`)
      }
      const stillExtra = planFlatten(latest, workspaceId).moves.some(
        (item) => item.pane_id === pane.pane_id,
      )
      if (!stillExtra) {
        console.log(`  Skipped ${pane.pane_id}: no longer an extra agent.`)
        continue
      }
      // A new-tab move carries the terminal without creating a shell pane.
      const result = asRecord(
        (
          await herdr([
            "pane",
            "move",
            pane.pane_id,
            "--new-tab",
            "--workspace",
            workspaceId,
            "--no-focus",
          ])
        ).move_result,
      )
      if (result.changed !== true) {
        throw new Error(`Move of ${pane.pane_id} was not applied`)
      }
      const moved = parsePane(result.pane)
      console.log(`  Moved ${moved.pane_id} to ${moved.tab_id}.`)
    }
    const finalPlan = planFlatten(await listPanes(workspaceId), workspaceId)
    reportNonAgents(finalPlan.nonAgentPanes)
    if (finalPlan.moves.length > 0) {
      throw new Error(
        "Extra agents remain; the layout changed. Rerun to replan",
      )
    }
    console.log("Each tab now has at most one recognized agent.")
  } else {
    reportNonAgents(plan.nonAgentPanes)
    if (plan.moves.length > 0) {
      console.log("Run with --run to move these panes.")
    }
  }
}

function reportNonAgents(panes: Pane[]): void {
  for (const pane of panes) {
    console.log(`  Left non-agent pane ${pane.pane_id} in ${pane.tab_id}.`)
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(
      `herdr-flatten: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exitCode = 1
  }
}

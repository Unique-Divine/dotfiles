/**
 * Typed gmailctl configs written in TypeScript.
 *
 * A config module default-exports a {@link GmailctlConfig}. The CLI renders it
 * to JSON, which gmailctl reads as `config.jsonnet` (JSON is valid Jsonnet).
 * Types mirror gmailctl's v1alpha3 schema in
 * `internal/engine/config/v1alpha3/config.go`.
 *
 * Usage: bun run email/gmailctl.ts <config.ts> <out/config.jsonnet>
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** A filter node: one operator or one or more match fields. */
export interface FilterNode {
  and?: FilterNode[];
  or?: FilterNode[];
  not?: FilterNode;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  replyto?: string;
  deliveredto?: string;
  subject?: string;
  list?: string;
  has?: string;
  /** Raw Gmail search query. */
  query?: string;
  /** Pass the value to Gmail without gmailctl's quoting. */
  isEscaped?: boolean;
}

export type Category =
  | "personal"
  | "social"
  | "updates"
  | "forums"
  | "promotions";

export interface Actions {
  /** Skip the inbox. */
  archive?: boolean;
  delete?: boolean;
  markRead?: boolean;
  star?: boolean;
  markSpam?: boolean;
  markImportant?: boolean;
  category?: Category;
  labels?: string[];
  forward?: string;
}

export interface Rule {
  filter: FilterNode;
  actions: Actions;
}

export interface LabelColor {
  background: string;
  text: string;
}

export interface Label {
  name: string;
  color?: LabelColor;
}

/** A message for an offline `gmailctl test` case. */
export interface TestMessage {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyto?: string[];
  deliveredto?: string[];
  lists?: string[];
  subject?: string;
  body?: string;
}

export interface Test {
  name?: string;
  messages: TestMessage[];
  /** Expected actions; `{}` means no rule matches. */
  actions: Actions;
}

export interface GmailctlConfig {
  version: "v1alpha3";
  author?: { name: string; email: string };
  labels?: Label[];
  rules: Rule[];
  tests?: Test[];
}

/** Match mail sent to any of `addresses`. */
export function anyTo(addresses: string[]): FilterNode {
  return { or: addresses.map((to) => ({ to })) };
}

/** Match mail from any of `senders` (addresses or domains). */
export function anyFrom(senders: string[]): FilterNode {
  return { or: senders.map((from) => ({ from })) };
}

/** Match when any node matches, flattening nested `or` nodes. */
export function anyOf(...nodes: FilterNode[]): FilterNode {
  const flat = nodes.flatMap((n) =>
    Object.keys(n).length === 1 && n.or ? n.or : [n],
  );
  return { or: flat };
}

/** Apply `label` to mail matching `filter`, leaving it in the inbox. */
export function labelRule(label: string, filter: FilterNode): Rule {
  return { filter, actions: { labels: [label] } };
}

/**
 * Check a config for mistakes gmailctl reports late or not at all: rules
 * that use undeclared labels, empty `or`/`and` nodes, and duplicate labels.
 * Returns a list of problems; empty means valid.
 *
 * A config without `labels` leaves labels unmanaged: gmailctl then creates
 * and deletes no labels, and rules may use any label that already exists in
 * Gmail, so the undeclared-label check is skipped.
 */
export function validateConfig(config: GmailctlConfig): string[] {
  const problems: string[] = [];
  const declared = new Set<string>();
  for (const label of config.labels ?? []) {
    if (declared.has(label.name)) {
      problems.push(`duplicate label: ${label.name}`);
    }
    declared.add(label.name);
  }
  const walk = (node: FilterNode, where: string): void => {
    for (const key of ["and", "or"] as const) {
      const children = node[key];
      if (children === undefined) continue;
      if (children.length === 0) problems.push(`${where}: empty ${key}`);
      children.forEach((c, i) => walk(c, `${where}.${key}[${i}]`));
    }
    if (node.not) walk(node.not, `${where}.not`);
  };
  config.rules.forEach((rule, i) => {
    walk(rule.filter, `rules[${i}].filter`);
    for (const label of rule.actions.labels ?? []) {
      if (config.labels !== undefined && !declared.has(label)) {
        problems.push(`rules[${i}]: undeclared label ${label}`);
      }
    }
  });
  return problems;
}

/** Render a config as gmailctl-readable Jsonnet with a generated header. */
export function renderConfig(config: GmailctlConfig, source: string): string {
  const header =
    `// Generated from ${source} by dotfiles/email/gmailctl.ts.\n` +
    "// Do not edit; change the source and run `just email-sync`.\n";
  return header + JSON.stringify(config, null, 2) + "\n";
}

/** Load a config module, validate it, and write the rendered file. */
export async function buildConfig(
  sourcePath: string,
  outPath: string,
): Promise<void> {
  const source = resolve(sourcePath);
  const mod: { default?: GmailctlConfig } = await import(source);
  if (!mod.default) throw new Error(`${source} has no default export`);
  const problems = validateConfig(mod.default);
  if (problems.length > 0) {
    throw new Error(`invalid config ${source}:\n  ${problems.join("\n  ")}`);
  }
  const dir = dirname(outPath);
  await mkdir(dir, { recursive: true });
  // Write a sibling temp file, then rename it over the output. The rename
  // replaces an old symlink instead of writing through it to a source file,
  // and a failed write leaves the previous config in place.
  const temp = join(dir, `.${basename(outPath)}.${process.pid}.tmp`);
  try {
    await writeFile(temp, renderConfig(mod.default, source));
    await rename(temp, outPath);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

if (import.meta.main) {
  const [sourcePath, outPath] = process.argv.slice(2);
  if (!sourcePath || !outPath) {
    console.error("usage: bun run email/gmailctl.ts <config.ts> <out>");
    process.exit(2);
  }
  try {
    await buildConfig(sourcePath, outPath);
    console.log(`wrote ${outPath}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

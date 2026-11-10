/**
 * Domain health check: registration via RDAP and DNS records via dig (or
 * DNS-over-HTTPS when dig is missing).
 *
 * Usage: bun run domain/health.ts [--json] [domains...]
 * Exits 1 when any domain has a FAIL finding.
 */
import { bash } from "@uniquedivine/bash"

export const DEFAULT_DOMAINS: string[] = ["uniquedivine.com", "dsn-braids.com"]
export const EXPIRY_FAIL_DAYS = 60
export const EXPIRY_WARN_DAYS = 180
export const IANA_RDAP_BOOTSTRAP = "https://data.iana.org/rdap/dns.json"
export const FALLBACK_RDAP_BASES: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/",
  net: "https://rdap.verisign.com/net/v1/",
}
export const AUTO_RENEW_NOTE =
  "auto-renew is not visible in RDAP; check it at the registrar (Squarespace)"

export type Level = "ok" | "warn" | "fail"

export interface Finding {
  level: Level
  message: string
}

export interface Registration {
  registrar: string | null
  registered: string | null
  expires: string | null
  daysUntilExpiry: number | null
  status: string[]
}

export interface DnsRecords {
  ns: string[]
  a: string[]
  mx: string[]
  spf: string[]
  dmarc: string[]
  ds: string[]
  source: "dig" | "doh"
}

export interface DomainReport {
  domain: string
  level: Level
  registration: Registration | null
  dns: DnsRecords | null
  findings: Finding[]
  notes: string[]
}

/** Minimal RDAP shapes (RFC 9083) used by this check. */
export interface RdapEntity {
  roles?: string[]
  vcardArray?: [string, unknown[][]]
}

export interface RdapEvent {
  eventAction: string
  eventDate: string
}

export interface RdapDomain {
  entities?: RdapEntity[]
  events?: RdapEvent[]
  status?: string[]
}

export interface RdapBootstrap {
  services: [string[], string[]][]
}

const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** True for a lowercase hostname safe to pass to dig and URLs. */
export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain)
}

/** Read the "fn" property of a jCard (RFC 7095) vcardArray. */
export function vcardName(entity: RdapEntity): string | null {
  const props = entity.vcardArray?.[1] ?? []
  for (const prop of props) {
    const [name, , , value] = prop
    if (name === "fn" && typeof value === "string") return value
  }
  return null
}

/** Whole days from `now` until `iso`, rounded down; negative once past. */
export function daysUntil(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime()
  return Math.floor(ms / 86_400_000)
}

/** Extract registrar, dates, and status flags from an RDAP domain object. */
export function parseRdap(rdap: RdapDomain, now: Date): Registration {
  const registrarEntity = (rdap.entities ?? []).find((entity) =>
    (entity.roles ?? []).includes("registrar"),
  )
  const eventDate = (action: string): string | null =>
    (rdap.events ?? []).find((event) => event.eventAction === action)
      ?.eventDate ?? null
  const expires = eventDate("expiration")
  return {
    registrar: registrarEntity ? vcardName(registrarEntity) : null,
    registered: eventDate("registration"),
    expires,
    daysUntilExpiry: expires ? daysUntil(expires, now) : null,
    status: rdap.status ?? [],
  }
}

/** Pick the RDAP base URL for a domain's TLD from the IANA bootstrap file. */
export function rdapBaseFor(
  domain: string,
  bootstrap: RdapBootstrap | null,
): string | null {
  const tld = domain.split(".").pop() ?? ""
  for (const [tlds, urls] of bootstrap?.services ?? []) {
    if (tlds.includes(tld)) {
      return urls.find((url) => url.startsWith("https://")) ?? urls[0] ?? null
    }
  }
  return FALLBACK_RDAP_BASES[tld] ?? null
}

/** Build the RDAP domain lookup URL from a base URL. */
export function rdapUrl(base: string, domain: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}domain/${domain}`
}

/** Registration checks: expiry window and registrar lock flags. */
export function checkRegistration(reg: Registration): Finding[] {
  const findings: Finding[] = []
  const days = reg.daysUntilExpiry
  if (days === null) {
    findings.push({ level: "fail", message: "expiration date missing" })
  } else if (days < EXPIRY_FAIL_DAYS) {
    findings.push({ level: "fail", message: `expires in ${days} days` })
  } else if (days < EXPIRY_WARN_DAYS) {
    findings.push({ level: "warn", message: `expires in ${days} days` })
  }
  if (!reg.status.includes("client transfer prohibited")) {
    findings.push({
      level: "fail",
      message: "missing client transfer prohibited (transfer lock off)",
    })
  }
  if (!reg.status.includes("client delete prohibited")) {
    findings.push({
      level: "warn",
      message: "missing client delete prohibited",
    })
  }
  return findings
}

/** DNS checks: delegation present; SPF and DMARC whenever MX exists. */
export function checkDns(dns: DnsRecords): Finding[] {
  const findings: Finding[] = []
  if (dns.ns.length === 0) {
    findings.push({ level: "fail", message: "no NS records" })
  }
  if (dns.mx.length > 0 && dns.spf.length === 0) {
    findings.push({ level: "warn", message: "MX present but no SPF record" })
  }
  if (dns.mx.length > 0 && dns.dmarc.length === 0) {
    findings.push({ level: "warn", message: "MX present but no DMARC record" })
  }
  return findings
}

/** Highest severity across findings. */
export function worstLevel(findings: Finding[]): Level {
  if (findings.some((f) => f.level === "fail")) return "fail"
  if (findings.some((f) => f.level === "warn")) return "warn"
  return "ok"
}

/** Join the quoted strings of one TXT record; unquoted input passes through. */
export function parseTxt(line: string): string {
  const parts = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  return parts.length > 0 ? parts.join("") : line.trim()
}

/** Split `dig +short` output into non-empty lines. */
export function parseDigShort(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(";"))
}

/** Keep TXT values that start with the given tag, e.g. "v=spf1". */
export function txtWithPrefix(records: string[], prefix: string): string[] {
  return records
    .map(parseTxt)
    .filter((txt) => txt.toLowerCase().startsWith(prefix.toLowerCase()))
}

/** Assemble the DNS record set from raw per-query answers. */
export function buildDnsRecords(
  raw: Record<DnsQueryKey, string[]>,
  source: DnsRecords["source"],
): DnsRecords {
  return {
    ns: [...raw.ns].sort(),
    a: [...raw.a].sort(),
    mx: [...raw.mx].sort(),
    spf: txtWithPrefix(raw.txt, "v=spf1"),
    dmarc: txtWithPrefix(raw.dmarc, "v=DMARC1"),
    ds: raw.ds,
    source,
  }
}

/** Combine registration and DNS results into one domain report. */
export function buildReport(
  domain: string,
  registration: Registration | null,
  dns: DnsRecords | null,
  errors: Finding[],
): DomainReport {
  const findings = [
    ...errors,
    ...(registration ? checkRegistration(registration) : []),
    ...(dns ? checkDns(dns) : []),
  ]
  return {
    domain,
    level: worstLevel(findings),
    registration,
    dns,
    findings,
    notes: [AUTO_RENEW_NOTE],
  }
}

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "?")
const list = (values: string[]): string =>
  values.length > 0 ? values.join(", ") : "none"

/** Render a compact human-readable report for one domain. */
export function formatReport(report: DomainReport): string {
  const lines = [`${report.domain}  ${report.level.toUpperCase()}`]
  const reg = report.registration
  if (reg) {
    const days = reg.daysUntilExpiry === null ? "?" : `${reg.daysUntilExpiry}d`
    lines.push(
      `  registrar  ${reg.registrar ?? "?"}`,
      `  dates      registered ${day(reg.registered)}, ` +
        `expires ${day(reg.expires)} (${days})`,
      `  status     ${list(reg.status)}`,
    )
  }
  const dns = report.dns
  if (dns) {
    lines.push(
      `  NS         ${list(dns.ns.map((ns) => ns.replace(/\.$/, "")))}`,
      `  A          ${list(dns.a)}`,
      `  MX         ${list(dns.mx)}`,
      `  SPF        ${dns.spf.length > 0 ? "yes" : "none"}`,
      `  DMARC      ${dns.dmarc.length > 0 ? "yes" : "none"}`,
      `  DNSSEC     ${dns.ds.length > 0 ? "on (DS present)" : "off (no DS)"}`,
    )
  }
  for (const finding of report.findings) {
    lines.push(`  ${finding.level.toUpperCase()}  ${finding.message}`)
  }
  for (const note of report.notes) lines.push(`  note: ${note}`)
  return lines.join("\n")
}

/** Exit code for a run: 1 when any report fails. */
export function exitCodeFor(reports: DomainReport[]): number {
  return reports.some((r) => r.level === "fail") ? 1 : 0
}

export interface CliArgs {
  json: boolean
  domains: string[]
}

/** Parse `[--json] [domains...]`; domains default to DEFAULT_DOMAINS. */
export function parseArgs(argv: string[]): CliArgs {
  const json = argv.includes("--json")
  const domains = argv
    .filter((arg) => arg !== "--json")
    .map((arg) => arg.toLowerCase().replace(/\.$/, ""))
  return { json, domains: domains.length > 0 ? domains : DEFAULT_DOMAINS }
}

// ---------------------------------------------------------------------------
// IO

export type DnsQueryKey = "ns" | "a" | "mx" | "txt" | "dmarc" | "ds"

const DNS_QUERIES: Record<DnsQueryKey, { type: string; prefix: string }> = {
  ns: { type: "NS", prefix: "" },
  a: { type: "A", prefix: "" },
  mx: { type: "MX", prefix: "" },
  txt: { type: "TXT", prefix: "" },
  dmarc: { type: "TXT", prefix: "_dmarc." },
  ds: { type: "DS", prefix: "" },
}

const DOH_TYPES: Record<string, number> = {
  A: 1, NS: 2, MX: 15, TXT: 16, DS: 43,
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/rdap+json, application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

async function hasDig(): Promise<boolean> {
  const out = await bash("command -v dig")
  return out.exitCode === 0
}

async function queryDig(name: string, type: string): Promise<string[]> {
  const out = await bash(`dig +short +time=5 +tries=2 ${type} ${name}`)
  if (out.exitCode !== 0) {
    throw new Error(`dig ${type} ${name}: ${out.stderr.trim() || out.stdout}`)
  }
  return parseDigShort(out.stdout)
}

interface DohResponse {
  Status: number
  Answer?: { type: number; data: string }[]
}

async function queryDoh(name: string, type: string): Promise<string[]> {
  const url = `https://dns.google/resolve?name=${name}&type=${type}`
  const res = await fetchJson<DohResponse>(url)
  // Status 3 is NXDOMAIN, which is an empty answer for our purposes.
  if (res.Status !== 0 && res.Status !== 3) {
    throw new Error(`DoH ${type} ${name}: status ${res.Status}`)
  }
  return (res.Answer ?? [])
    .filter((answer) => answer.type === DOH_TYPES[type])
    .map((answer) => answer.data)
}

async function lookupDns(
  domain: string,
  useDig: boolean,
): Promise<DnsRecords> {
  const query = useDig ? queryDig : queryDoh
  const keys = Object.keys(DNS_QUERIES) as DnsQueryKey[]
  const answers = await Promise.all(
    keys.map((key) => {
      const { type, prefix } = DNS_QUERIES[key]
      return query(`${prefix}${domain}`, type)
    }),
  )
  const raw = Object.fromEntries(keys.map((k, i) => [k, answers[i]]))
  return buildDnsRecords(
    raw as Record<DnsQueryKey, string[]>,
    useDig ? "dig" : "doh",
  )
}

async function loadBootstrap(): Promise<RdapBootstrap | null> {
  try {
    return await fetchJson<RdapBootstrap>(IANA_RDAP_BOOTSTRAP)
  } catch {
    return null
  }
}

async function checkDomain(
  domain: string,
  bootstrap: RdapBootstrap | null,
  useDig: boolean,
  now: Date,
): Promise<DomainReport> {
  if (!isValidDomain(domain)) {
    return buildReport(domain, null, null, [
      { level: "fail", message: "not a valid domain name" },
    ])
  }
  const errors: Finding[] = []
  let registration: Registration | null = null
  let dns: DnsRecords | null = null
  const base = rdapBaseFor(domain, bootstrap)
  try {
    if (!base) throw new Error("no RDAP server known for this TLD")
    registration = parseRdap(
      await fetchJson<RdapDomain>(rdapUrl(base, domain)),
      now,
    )
  } catch (err) {
    errors.push({ level: "fail", message: `RDAP: ${String(err)}` })
  }
  try {
    dns = await lookupDns(domain, useDig)
  } catch (err) {
    errors.push({ level: "fail", message: `DNS: ${String(err)}` })
  }
  return buildReport(domain, registration, dns, errors)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const [bootstrap, useDig] = await Promise.all([loadBootstrap(), hasDig()])
  const now = new Date()
  const reports = await Promise.all(
    args.domains.map((d) => checkDomain(d, bootstrap, useDig, now)),
  )
  if (args.json) {
    const out = { checkedAt: now.toISOString(), reports }
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log(reports.map(formatReport).join("\n\n"))
  }
  process.exit(exitCodeFor(reports))
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error(err)
    process.exit(2)
  }
}

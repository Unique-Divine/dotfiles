import { describe, expect, test } from "bun:test"

import {
  AUTO_RENEW_NOTE,
  buildDnsRecords,
  buildReport,
  checkDns,
  checkRegistration,
  daysUntil,
  DEFAULT_DOMAINS,
  exitCodeFor,
  formatReport,
  isValidDomain,
  parseArgs,
  parseDigShort,
  parseRdap,
  parseTxt,
  rdapBaseFor,
  rdapUrl,
  worstLevel,
  type DnsRecords,
  type RdapBootstrap,
  type RdapDomain,
  type Registration,
} from "./health"
import fixture from "./fixtures/rdap-uniquedivine.com.json"

// Real RDAP response from rdap.verisign.com, captured 2026-11-08.
const rdap = fixture as unknown as RdapDomain
const NOW = new Date("2026-11-09T00:00:00Z")

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    registrar: "Squarespace Domains LLC",
    registered: "2020-05-21T16:45:08Z",
    expires: "2027-05-21T16:45:08Z",
    daysUntilExpiry: 193,
    status: ["client delete prohibited", "client transfer prohibited"],
    ...overrides,
  }
}

function dnsRecords(overrides: Partial<DnsRecords> = {}): DnsRecords {
  return {
    ns: ["ns-cloud-a1.googledomains.com."],
    a: ["199.36.158.100"],
    mx: [],
    spf: [],
    dmarc: [],
    ds: [],
    source: "dig",
    ...overrides,
  }
}

describe("parseRdap", () => {
  test("reads registrar, dates, and status from the real fixture", () => {
    expect(parseRdap(rdap, NOW)).toEqual({
      registrar: "Squarespace Domains LLC",
      registered: "2020-05-21T16:45:08Z",
      expires: "2027-05-21T16:45:08Z",
      daysUntilExpiry: 193,
      status: ["client delete prohibited", "client transfer prohibited"],
    })
  })

  test("tolerates an empty object", () => {
    expect(parseRdap({}, NOW)).toEqual({
      registrar: null,
      registered: null,
      expires: null,
      daysUntilExpiry: null,
      status: [],
    })
  })
})

describe("daysUntil", () => {
  test("floors partial days and goes negative once past", () => {
    expect(daysUntil("2026-11-10T12:00:00Z", NOW)).toBe(1)
    expect(daysUntil("2026-11-08T00:00:00Z", NOW)).toBe(-1)
  })
})

describe("checkRegistration", () => {
  test("healthy registration has no findings", () => {
    expect(checkRegistration(registration())).toEqual([])
  })

  test("expiry thresholds: warn under 180 days, fail under 60", () => {
    expect(checkRegistration(registration({ daysUntilExpiry: 180 })))
      .toEqual([])
    expect(checkRegistration(registration({ daysUntilExpiry: 179 })))
      .toEqual([{ level: "warn", message: "expires in 179 days" }])
    expect(checkRegistration(registration({ daysUntilExpiry: 59 })))
      .toEqual([{ level: "fail", message: "expires in 59 days" }])
  })

  test("missing lock flags", () => {
    const findings = checkRegistration(registration({ status: ["active"] }))
    expect(findings.map((f) => f.level)).toEqual(["fail", "warn"])
  })

  test("missing expiration fails", () => {
    const findings = checkRegistration(
      registration({ expires: null, daysUntilExpiry: null }),
    )
    expect(findings[0]?.level).toBe("fail")
  })
})

describe("checkDns", () => {
  test("no MX means SPF and DMARC are not required", () => {
    expect(checkDns(dnsRecords())).toEqual([])
  })

  test("MX without SPF or DMARC warns", () => {
    const findings = checkDns(dnsRecords({ mx: ["1 smtp.google.com."] }))
    expect(findings.map((f) => f.level)).toEqual(["warn", "warn"])
  })

  test("MX with SPF and DMARC is clean", () => {
    const dns = dnsRecords({
      mx: ["1 smtp.google.com."],
      spf: ["v=spf1 include:_spf.google.com ~all"],
      dmarc: ["v=DMARC1; p=none"],
    })
    expect(checkDns(dns)).toEqual([])
  })

  test("missing NS fails", () => {
    expect(worstLevel(checkDns(dnsRecords({ ns: [] })))).toBe("fail")
  })
})

describe("TXT and dig parsing", () => {
  test("joins split TXT strings and strips quotes", () => {
    expect(parseTxt('"v=spf1 include:_spf.google.com" " ~all"')).toBe(
      "v=spf1 include:_spf.google.com ~all",
    )
    expect(parseTxt("v=DMARC1; p=none")).toBe("v=DMARC1; p=none")
  })

  test("parseDigShort drops blanks and comments", () => {
    const out = "ns-cloud-a2.googledomains.com.\n\n;; timeout\nx.\n"
    expect(parseDigShort(out)).toEqual([
      "ns-cloud-a2.googledomains.com.",
      "x.",
    ])
  })

  test("buildDnsRecords filters SPF and DMARC from TXT answers", () => {
    const dns = buildDnsRecords(
      {
        ns: ["b.", "a."],
        a: [],
        mx: [],
        txt: ['"hosting-site=dsn-braids"', '"v=spf1 -all"'],
        dmarc: ['"v=DMARC1; p=reject"'],
        ds: [],
      },
      "dig",
    )
    expect(dns.ns).toEqual(["a.", "b."])
    expect(dns.spf).toEqual(["v=spf1 -all"])
    expect(dns.dmarc).toEqual(["v=DMARC1; p=reject"])
  })
})

describe("RDAP bootstrap", () => {
  const bootstrap: RdapBootstrap = {
    services: [
      [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
      [
        ["io"],
        [
          "http://rdap.example/",
          "https://rdap.identitydigital.services/rdap/",
        ],
      ],
    ],
  }

  test("prefers https URLs from the bootstrap", () => {
    expect(rdapBaseFor("uniquedivine.com", bootstrap)).toBe(
      "https://rdap.verisign.com/com/v1/",
    )
    expect(rdapBaseFor("x.io", bootstrap)).toBe(
      "https://rdap.identitydigital.services/rdap/",
    )
  })

  test("falls back to Verisign for .com without a bootstrap", () => {
    expect(rdapBaseFor("dsn-braids.com", null)).toBe(
      "https://rdap.verisign.com/com/v1/",
    )
    expect(rdapBaseFor("x.zz", null)).toBeNull()
  })

  test("rdapUrl appends the domain path", () => {
    expect(rdapUrl("https://r.example/v1", "a.com")).toBe(
      "https://r.example/v1/domain/a.com",
    )
  })
})

describe("report and CLI", () => {
  test("report for the real fixture is OK and notes auto-renew", () => {
    const report = buildReport(
      "uniquedivine.com",
      parseRdap(rdap, NOW),
      dnsRecords(),
      [],
    )
    expect(report.level).toBe("ok")
    expect(report.notes).toEqual([AUTO_RENEW_NOTE])
    const text = formatReport(report)
    expect(text).toContain("uniquedivine.com  OK")
    expect(text).toContain("Squarespace Domains LLC")
    expect(text).toContain("expires 2027-05-21 (193d)")
    expect(text).toContain("DNSSEC     off (no DS)")
    expect(exitCodeFor([report])).toBe(0)
  })

  test("a fail finding sets a non-zero exit code", () => {
    const report = buildReport("a.com", null, null, [
      { level: "fail", message: "RDAP: down" },
    ])
    expect(formatReport(report)).toContain("FAIL  RDAP: down")
    expect(exitCodeFor([report])).toBe(1)
  })

  test("parseArgs defaults domains and reads --json", () => {
    expect(parseArgs([])).toEqual({ json: false, domains: DEFAULT_DOMAINS })
    expect(parseArgs(["--json", "Example.COM."])).toEqual({
      json: true,
      domains: ["example.com"],
    })
  })

  test("isValidDomain rejects shell metacharacters", () => {
    expect(isValidDomain("dsn-braids.com")).toBe(true)
    expect(isValidDomain("a.com;rm -rf ~")).toBe(false)
    expect(isValidDomain("localhost")).toBe(false)
  })
})

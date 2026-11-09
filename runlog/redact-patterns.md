# Redact Patterns

`redact-patterns.json` lists `{kind, regex}` entries. Each match becomes
`[redacted:<kind>]`. JSON has no comments, so the rules live here.

## How Patterns Apply

- Every writer applies every pattern case-insensitively and globally:
  jq `gsub($r.regex; "\(.keep // "")[redacted:\($r.kind)]"; "gi")`, and
  JS `new RegExp(r.regex, "gi")` with the same replacement. So `token=`
  also matches `API_TOKEN=`, and `Bearer` matches `bearer`.
- A named group `(?<keep>...)` stays readable in front of the marker.
  Patterns that must match the key name use it, so
  `--private-key 0x<key>` becomes `--private-key 0x[redacted:evm-key]`.
  It's the only named group a pattern may use.
- Patterns apply in file order. Token shapes come first, the `evm-key`
  context rule last. The key patterns skip a value that is already
  `[redacted:...]`.
- Token shapes start with `(?<![A-Za-z0-9_-])`, so a prefix inside a word
  (`task-add-...`, `risk-...`) isn't a token, and a long `eyJ` run is
  scanned from its start only, not from every `eyJ` in it.
- Key patterns keep the key and replace only the value. Each key has
  these forms:
  - `-value`: `KEY=value`, `KEY = value`, `KEY:=value`, `KEY := value`,
    each bare, `"quoted"`, `'quoted'`, or with escaped quotes
    (`KEY=\"value\"`). Keys: `token`, `secret`, `secret_key`, `password`,
    `api_key`, `private_key`, `access_key` (covers
    `AWS_SECRET_ACCESS_KEY`), `mnemonic`, `seed_phrase`, and `seedphrase`.
    `mnemonic-value` also takes the `--mnemonic` flag of `cast` and
    `forge`: `--mnemonic "<phrase>"`, `--mnemonic=<phrase>`, or
    `--mnemonic <phrase>` to the end of the line.
  - `-json`: `"key": "value"`, plain or escaped inside a JSON string. Keys
    as above, plus the camelCase `secretKey`, `apiKey`, `privateKey`, and
    `accessKey`. `accessToken` and `clientSecret` end in `token` and
    `secret`, so they're covered already.
  - `-yaml`: `key: value`, quoted as in `-value`. Keys as `-value`, plus
    `seed phrase`.
- A bare value ends at whitespace, `&`, a quote, or a backslash. A quoted
  value ends at its closing quote, a backslash, or a line break, so
  `PASSWORD="two words"` is redacted whole. A bare `mnemonic` or seed
  phrase value runs to the end of the line, since it has spaces. No value
  pattern consumes a backslash or a quote, so redacting JSON text keeps it
  valid.
- `evm-key` takes a 64-hex key only after a key word: `private_key`,
  `privateKey`, `privkey`, `*_PK`, `pk`, `--private-key`,
  `--private-keys`, or `accounts`,
  with optional quotes, `:` or `=`, `[`, and `0x` between. A bare
  `0x<64 hex>` is never redacted: tx hashes, block hashes, event topics,
  storage slots, and `bytes32` constants must stay readable.
- URL userinfo:
  - `url-password` replaces the password in `scheme://user:password@`,
    with an empty user too (`redis://:<pass>@`). The password may hold
    `/`, but not as a port and path: `https://host:8080/a@v1` stays.
  - `url-token` replaces a user of 20 to 64 `[A-Za-z0-9_-]` characters,
    which is a token used as the username: `https://<token>@host` and
    `https://<token>:x-oauth-basic@host`. It runs after `url-password`,
    so neither part survives.
  - `ssh://git@host:22`, `https://host:8080/a@v1`, and
    `git@github.com:o/r` don't match.
- `user-password` replaces the password in curl's `-u user:pass` and
  `--user user:pass` (or `--user=`), quoted or not, keeping the user. An
  all-digit password is left, so `docker run -u 1000:1000` stays.
- `authorization` covers `Authorization: Basic <v>` and
  `Authorization: token <v>`. A bare `basic` never matches, so prose like
  "basic configuration" stays. `bearer` covers `Bearer <v>` anywhere.
- A seed phrase is keyed on `seed_phrase`, `seedphrase`, or `seed phrase`
  only. An RNG `seed=42` stays.

## PEM Private Keys

PEM bodies span lines, so the rule is code, not a pattern: `redactPemLines`
in `runlog.ts` and `pem_lines` in `runlog.sh`.

- After a line holding `-----BEGIN <label> PRIVATE KEY-----` or the PGP
  `-----BEGIN PGP PRIVATE KEY BLOCK-----`, each line matching
  `^[-+ ]?[ \t]*(?:[0-9]+\t)?[A-Za-z0-9+/=]{16,100}\r?$` becomes
  `[redacted:pem]`. The prefix stays: a diff mark (`+`, `-`, or a space),
  indentation, as in a YAML `|` block, and a line number as Claude's Read
  tool prints it (`     2\t`).
- Blank lines and the armor headers `Proc-Type:`, `DEK-Info:`,
  `Version:`, `Comment:`, `Charset:`, and `Hash:`, with the same prefix,
  keep the block open. The block ends at the END line or at the first
  line that fits none of these, so a header string in Go code never eats
  the code after it, and nothing is deleted to the end of the file.
- It runs over a whole file before the per-line passes, and over every
  multi-line string before the patterns.
- A body line under 16 characters, such as a short last line or a PGP
  `=XXXX` checksum, isn't redacted.
- The `pem` pattern catches a PEM or PGP key inside a JSON string, where
  its line breaks are an escaped `\n`. It replaces everything between the
  BEGIN and END markers and keeps both. It needs the END marker within
  8,192 characters on the same line.

## Lines and Files

Files and the tap's `agent.jsonl` copy are redacted line by line
(`redactLines` in `runlog.ts`, `redact_lines` in `runlog.sh`). A line whose
first non-blank character is `{` or `[` and that parses as JSON first has
its decoded strings redacted, so `KEY=\"value\"` in the raw line reads as
`KEY="value"`. The line is re-encoded only when a string changed. Every
line is then redacted as text, which catches `"password": "..."` pairs.

When `ud runs redact-file` can't run, `runlog.sh` falls back to jq. That
path keeps the first 1 MiB of a file, cut at a full line, marks the
artifact `truncated`, and logs `warn redact-fallback-capped`. If redaction
fails outright, a source inside the run folder is deleted, not left raw.

## Writing a Pattern jq Accepts

jq uses Oniguruma, and JS runs the same string without the `u` flag. A
pattern must compile and mean the same in both:

- Lookbehind is fixed-width only. Put alternatives in separate lookbehind
  groups, `(?:(?<=a)|(?<=bc))`, never `(?<=a|bc)`. No `*`, `+`, or
  `{m,n}` inside a lookbehind. List spaced forms (`key = `, `key := `)
  instead.
- No `\K`, no backreferences, no named groups other than `keep`, and no
  inline flags such as `(?i)`.
- Don't use `\s`, `\b`, `\w`, or `.`. Oniguruma reads them as Unicode
  classes and JS without `u` as ASCII, so they differ on characters such
  as U+0085, U+FEFF, and U+2028. List the characters instead, as the
  value patterns list whitespace, and write a word start as
  `(?<![A-Za-z0-9_])`.
- No `^` or `$`, since a field value may hold several lines.
- Start a costly lookbehind group with a one-character guard such as
  `(?<=[= ])`. Most positions fail it, which keeps long text fast.

`runlog_start` compiles each pattern in jq once. One that fails is dropped
and logged as `warn redact-pattern-invalid` with its `kind`; the writer
stays on. JS skips a pattern it can't compile. `redact-parity.test.ts`
compiles each pattern alone in jq and JS, and runs a corpus through both
writers, failing on any difference. The corpus includes normal Nibiru and
EVM lines that must come through untouched.

## Not Covered

These are not redacted. Read a run log with them in mind.

- A key with no key word before it, such as the bare hex that
  `nibid keys export --unarmored-hex` prints, or the second key in an
  `accounts: [...]` list.
- A seed phrase on its own line, with no key word, such as the phrase
  `nibid keys add` or `--recover` prints.
- URL userinfo the URL rules don't take:
  - a token as the username under 20 characters, or with characters
    outside `[A-Za-z0-9_-]`;
  - a password holding whitespace, a quote, or a backslash, or one that
    starts with 1 to 5 digits and a `/`, `?`, or `#`, which reads as a
    port.
- curl's `-uuser:pass` with no space, and an all-digit `-u` password.
- Base64-, URL-, or otherwise encoded secrets, and fullwidth forms such as
  `token＝value`.
- A PEM body without its BEGIN line in the same text.
- A token cut across two lines, or one right after a word character, `-`,
  or `_` (`x-sk-...`).
- `Cookie:` and `Set-Cookie:` values, and headers other than
  `Authorization: Basic`, `Authorization: token`, and `Bearer`.
- Key names other than those listed, such as `passwd` or `credentials`.
- Engine differences:
  - Oniguruma folds a few non-ASCII letters to ASCII (`ſ` to `s`, the
    Kelvin sign to `k`), and JS without `u` doesn't. jq then redacts
    `ſecret=x` and JS doesn't. The parity corpus is ASCII keys only.
  - jq's `fromjson` accepts `nan`, and jq keeps number literals such as
    `1.0` when it re-encodes; JS rejects `nan` and prints `1`. Only a
    re-encoded line can differ, and both engines still redact it.

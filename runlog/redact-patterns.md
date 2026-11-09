# Redact Patterns

`redact-patterns.json` lists `{kind, regex}` entries. Each match becomes
`[redacted:<kind>]`. JSON has no comments, so the rules live here.

- Every writer applies every pattern case-insensitively and globally:
  jq `gsub($r.regex; "[redacted:\($r.kind)]"; "gi")`, and JS
  `new RegExp(r.regex, "gi")`. So `token=` also matches `API_TOKEN=`, and
  `Bearer` matches `bearer`.
- Patterns apply in file order. Token shapes come first. The `KEY=value`
  and JSON patterns skip a value that is already `[redacted:...]`.
- Each regex must mean the same in jq's Oniguruma and in JS without the
  `u` flag. Lookbehind is fixed-width, with alternatives as separate
  lookbehind groups (`(?:(?<=a)|(?<=bc))`, never `(?<=a|bc)`). Don't use `\s`
  to end a value, since the engines differ on U+0085 and U+FEFF. List the
  whitespace instead. Don't use `.`, since it differs on U+2028.
- Known gap: Oniguruma folds a few non-ASCII letters to ASCII (`ſ` to `s`,
  the Kelvin sign to `k`), and JS without `u` doesn't. jq then redacts
  `ſecret=x` and JS doesn't. The parity corpus is ASCII keys only.
- Key patterns keep the key and replace only the value, so the replacement
  stays the same in both engines.
- `runlog/redact-parity.test.ts` runs a corpus through both writers and
  fails on any difference.

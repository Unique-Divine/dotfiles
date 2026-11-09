# Redact Patterns

`redact-patterns.json` lists `{kind, regex}` entries. Each match becomes
`[redacted:<kind>]`. JSON has no comments, so the rules live here.

- Every writer applies every pattern case-insensitively and globally:
  jq `gsub($r.regex; "[redacted:\($r.kind)]"; "gi")`, and JS
  `new RegExp(r.regex, "gi")`. So `token=` also matches `API_TOKEN=`, and
  `Bearer` matches `bearer`.
- Patterns apply in file order. Token shapes come first. The key patterns
  skip a value that is already `[redacted:...]`.
- Token shapes start with `(?<![A-Za-z0-9_-])`, so a prefix inside a word
  (`task-add-...`, `risk-...`) isn't a token, and a long `eyJ` run is
  scanned from its start only, not from every `eyJ` in it.
- Key patterns keep the key and replace only the value, so the replacement
  stays the same in both engines. Each key has these forms:
  - `-value`: `KEY=value`, `KEY="value"`, `KEY='value'`, and the escaped
    `KEY=\"value\"`. Keys: `token`, `secret`, `secret_key`, `password`,
    `api_key`, `private_key`, `access_key` (covers
    `AWS_SECRET_ACCESS_KEY`), and `mnemonic`.
  - `-json`: `"key": "value"`, plain or escaped inside a JSON string.
    Keys: `token`, `secret`, `password`, `api_key`, `private_key`,
    `access_key`, and `mnemonic`.
  - `-yaml`: `key: value`, quoted as in `-value`. Keys: `token`,
    `secret`, `password`, `api_key`, `private_key`, and `mnemonic`.
- A bare value ends at whitespace, `&`, a quote, or a backslash. A quoted
  value ends at its closing quote, a backslash, or a line break, so
  `PASSWORD="two words"` is redacted whole. A bare `mnemonic` value runs to
  the end of the line, since a seed phrase has spaces. No value pattern
  consumes a backslash or a quote, so redacting JSON text keeps it valid.
- Files and the tap's `agent.jsonl` copy are redacted line by line
  (`redactLines` in `runlog.ts`, `redact_lines` in `runlog.sh`). A line
  whose first non-blank character is `{` or `[` and that parses as JSON
  first has its decoded strings redacted, so `KEY=\"value\"` in the raw
  line reads as `KEY="value"`. The line is re-encoded only when a string
  changed. Every line is then redacted as text, which catches
  `"password": "..."` pairs.
- Each regex must mean the same in jq's Oniguruma and in JS without the
  `u` flag. Lookbehind is fixed-width, with alternatives as separate
  lookbehind groups (`(?:(?<=a)|(?<=bc))`, never `(?<=a|bc)`). Don't use `\s`
  to end a value, since the engines differ on U+0085 and U+FEFF. List the
  whitespace instead. Don't use `.`, since it differs on U+2028.
- Known gaps:
  - Oniguruma folds a few non-ASCII letters to ASCII (`ſ` to `s`, the
    Kelvin sign to `k`), and JS without `u` doesn't. jq then redacts
    `ſecret=x` and JS doesn't. The parity corpus is ASCII keys only.
  - jq's `fromjson` accepts `nan`, and jq keeps number literals such as
    `1.0` when it re-encodes; JS rejects `nan` and prints `1`. Only a
    re-encoded line can differ, and both engines still redact it.
  - A token shape right after a word character, `-`, or `_` (`x-sk-...`)
    isn't redacted.
- `runlog/redact-parity.test.ts` runs a corpus through both writers and
  fails on any difference.

# Email

Tooling for Gmail filters and labels, used with Superhuman as the mail
client. This directory is public. The real filter configs are private and
live outside this repo.

## Where Filters Live

| What | Where | Why |
|---|---|---|
| Gmail filters and labels | gmailctl config written in TypeScript, private | Filters run on Gmail's servers, so every client, the Gmail connector, and agents see the same labels. |
| Superhuman splits | Superhuman app settings | Splits are saved searches that only Superhuman reads. The Superhuman MCP can list them but not edit them, so each split stays a thin `label:<name>` query. |
| Tooling and an example config | This directory | Install and link steps can be public. |
| The real filter lists | A private repo | Publishing which senders and addresses get priority would invite people to game them. |

## Install gmailctl

[gmailctl](https://github.com/mbrt/gmailctl) is a third-party Go tool
(MIT) that manages filters through the Gmail API. Build it from a source
clone:

```bash
just gmailctl-install   # clones ~/ki/gmailctl or pulls it, then go install
```

The binary lands in `$(go env GOPATH)/bin/gmailctl`.

## Configs in TypeScript

Each config is a TypeScript module that default-exports a `GmailctlConfig`,
typed in [gmailctl.ts](./gmailctl.ts) after gmailctl's v1alpha3 schema.
Helpers such as `anyTo`, `anyFrom`, `anyOf`, and `labelRule` build filters
from plain arrays, so lists can carry JSDoc and be computed. The renderer
checks for undeclared labels, empty `or`/`and` nodes, and duplicate labels,
then writes JSON, which gmailctl reads as Jsonnet.

[gmailctl-example.ts](./gmailctl-example.ts) shows the shape.
`bun test email/` covers the helpers.

## Generate the Private Configs

```bash
just email-sync
```

This renders each private config that exists and skips the rest:

| Private source | Generated file |
|---|---|
| `$BOKU/priv-skills/ud/email/gmailctl-nibi.ts` | `~/.config/gmailctl/config.jsonnet` |
| `$BOKU/priv-skills/ud/email/gmailctl-ud.ts` | `~/.config/gmailctl-ud/config.jsonnet` |

`$BOKU` defaults to `~/ki/boku`. `just sync` runs `email-sync` too. The
generated files are never edited or committed; change the TypeScript and
run `just email-sync` again.

Credentials (`credentials.json`) and tokens (`token.json`) stay in each
`~/.config/gmailctl*` directory and never go in a repo.

## Authorize a Mailbox

1. In Google Cloud Console, enable the Gmail API in a project.
2. Set the OAuth consent screen to Internal for a Workspace account. Add
   the scopes `gmail.settings.basic` and `gmail.labels`.
3. Create an OAuth client ID of type Desktop app. Save the JSON as
   `credentials.json` in the config directory.
4. Run `gmailctl init` (add `--config ~/.config/gmailctl-ud` for the
   `ud@` mailbox).

## Everyday Use

```bash
just email-sync  # regenerate from TypeScript
gmailctl test    # offline tests in the config
gmailctl diff    # compare with live Gmail filters
gmailctl apply   # replace live filters with the config
```

Skip `gmailctl edit`, which edits the generated file. `apply` replaces the
whole filter set. On a mailbox with existing filters, run
`gmailctl download` first and port its rules into the TypeScript. Filters
only act on new mail; label existing mail with a search in Gmail or
Superhuman.

## Superhuman Notes

- Marking a thread Done in Superhuman archives it in Gmail.
- Superhuman writes its own AI labels as `[Superhuman]/AI/*`, searchable in
  Gmail as `label:[superhuman]-ai-news` and similar.
- Splits only show inbox threads, so archived mail drops out of a split even
  when it still has the label.

The agent workflow (label convention, bulk actions, triage rules) is in the
private `ud` agent skill, branch `email.md`.

## Gmail Archive Bridge

`just gmail-bridge` runs [gmail-bridge.ts](./gmail-bridge.ts), a persistent
JSONL transport for the private local archive. Send one request per line:

```json
{"version":1,"request_id":"connect-1","account":"reader@example.org","op":"connect","args":{"interactive":false}}
```

Responses echo `version` and `request_id`, with `ok` and either `data` or
`error: {code, message, retryable}`. Stdout contains JSONL only. Interactive
OAuth browser instructions go to stderr. Each account must authorize
`gmail.modify`; noninteractive calls return `auth_required` when necessary.
Tokens use the existing mail-state-sync private token directory. The bridge
checks the signed-in identity against the requested account.

Operations are `connect`, `profile`, `list`, `fetch`, `threads`, `history`,
`labels`, `create_labels`, `modify`, and `unsubscribe`. Provider responses
retain their original fields. `fetch` and `threads` use HTTP multipart batches
of at most 50 and report individual failures. Separate text MIME bodies
appear in `text_parts`, with per-message `completeness`; binary attachments
are never downloaded. `threads` refreshes conversation membership before
applying a conversation decision. `modify` accepts at most 1000 message IDs.
Missing labels are created without replacing the existing catalog.

The bridge weighs requests using the current Gmail quota costs, including
60 units for full messages, 20 for minimal messages, and the sum of multipart
children. Defaults are 6000 units per minute per account and 1200000 per
project. These limits govern a single bridge process; callers should share
one process rather than launch competing collectors. Quota 403s, 429s,
Retry-After, transient reads, and expired access tokens receive bounded
retries. Uncertain writes return `uncertain_result` for reconciliation.

One-click unsubscribe requires declared RFC 8058 HTTPS headers. It rejects
recognized group relays and local/private destinations, makes a separate POST
without Gmail authorization, follows no redirects, and never sends email.
Network failures return `outcome: "uncertain"` and are never blindly retried.
Callers own approval, protected-mail checks, and durable cleanup records.

| Environment | Meaning |
|---|---|
| `UD_MAIL_CREDENTIALS` | OAuth client JSON path. Defaults to the mail-state-sync credentials path. |
| `UD_MAIL_TOKEN_DIR` | Private per-account token directory override. |
| `UD_MAIL_ACCOUNT_QUOTA` | Per-account quota units per minute. |
| `UD_MAIL_PROJECT_QUOTA` | Shared project quota units per minute. |

Run `just email-test` for transport and existing filter/sync tests, and
`just email-check` for native Bun type checking. Tests use local HTTP servers
and synthetic mail. They do not contact live mailboxes.

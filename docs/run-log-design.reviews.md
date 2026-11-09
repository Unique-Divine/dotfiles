# Run Log Design Reviews

## Round 1

### Comment A, on Agent Output

"But how do Codex and Claude do it? Where do you store a log line? What if
the standard out or standard error from the agent chat shows a certain thing?
How do we do that, or do you just point to the other transcript and say where
it is in the transcript? Is that what your idea was, or how does that kind of
work for me?"

The answer the user agreed with:

- `git_mf --agent` keeps a redacted copy of the agent's own JSONL stream as
  `agent.jsonl` in the run folder. For Claude, that's
  `claude -p --output-format stream-json --verbose`. For Codex, it's
  `codex exec --json`. The stream is teed so progress still shows live, as
  one short readable line per step.
- While reading the stream, `git_mf` logs notable moments as events in our
  run file. Phase 1 has one kind, `agent-command`: a command that exited
  non-zero, with `cmd`, `exit`, and `ref: {file: "agent.jsonl", line: N}`
  pointing into the saved copy.
- The session id is still recorded, and the transcript link is a bonus while
  it exists. The copy outlives Claude's 30-day cleanup because we prune it on
  our own schedule.
- The reader adds `boku-runs agent <id> [--at N]`, which renders the stream
  readably and can jump to a line with some context around it.
- The report's Challenges section stays as the agent's own explanation. The
  stream is what actually happened.

### Comment B, on Location

"Okay, I think we're in agreement about the design so far. The only thing I
would change is that, instead of the directory being called dotfiles, I
prefer that it be... what is it called, `.boku`, similar to how we have
.codex and .claude. And it's okay that it'll have dotfiles content. I may
want to add other runs that stay on my machine as a custom setup, so maybe
the dotfiles state will be a subdirectory inside of Boku or whatever. I don't
know. I don't know if that's following XDG or if it should be custom to my
own tool, but who cares about the XDG dirs, right? ... technically, this will
be a tool as part of Boku. Maybe it's developed inside of dotfiles, and then
Boku uses it when I add other tools because I'm going to do other cool stuff
with cron jobs and things on my machine."

### How the Draft Changed

- Root moved to `~/.boku/` (`BOKU_HOME` overrides). XDG state is dropped;
  caches stay in `XDG_CACHE_HOME`.
- One shared `~/.boku/runs/` for every producer, with a required `source`
  field. `~/.boku/dotfiles/` holds non-run dotfiles state.
- Environment variables renamed from `DOTFILES_*` to `BOKU_*`.
- Code lives in the dotfiles repo under `runlog/`; the reader is `boku-runs`
  on PATH plus `just runs`.
- Agent stream capture added: `agent.jsonl`, the `agent-command` event,
  `boku-runs agent <id> [--at N]`, redaction, and fixture tests.
- Open questions answered and turned into a Decisions section.
- Trimmed toward a 10-minute read.

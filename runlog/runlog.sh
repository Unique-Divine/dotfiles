#!/usr/bin/env bash
# runlog.sh: bash writer for the Boku run log (see docs/run-log-design.md).
#
# Source it, then:
#   runlog_start TOOL [ARG...]       writes start; exports BOKU_RUN_ID and
#                                    BOKU_ROOT_RUN_ID while active
#   runlog_active                    0 if this process's run is logging
#   runlog_event KIND [KEY=VAL ...]  KEY=VAL is a string; KEY:=JSON is raw
#   runlog_step NAME CMD [ARG...]    runs an external command, logs a step,
#                                    returns the command's status
#   runlog_artifact KIND FILE        copies FILE (capped, redacted) into
#                                    the run folder
#   runlog_dir                       prints the run folder (creates it)
#   runlog_file                      prints the run's events file
#   runlog_end EXIT [status=...]     writes end and the day's index line
#
# Safe under `set -Eeuo pipefail`: every internal command ends in `|| true`
# or sits in a condition, and no unset variable is read bare. The writer
# fails open: after its first error it turns off for the rest of this
# process (BOKU_RUNLOG_DEBUG=1 prints why). BOKU_RUNLOG=0 turns it off. It
# sets no traps; callers run `runlog_end` from their own exit handler.

# Folder holding this file and redact-patterns.json, found at source time.
_runlog_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null \
  && pwd)" || _runlog_lib_dir=""

# Process state. Not exported, so each child process starts fresh.
_runlog_on="${_runlog_on:-0}"           # 1: run started, events are built
_runlog_file_on="${_runlog_file_on:-0}" # 1: events go to the run file
_runlog_broken="${_runlog_broken:-0}"   # 1: an error turned the writer off
_runlog_stdout="${_runlog_stdout:-0}"   # 1: events are also printed
_runlog_line=""
_runlog_ms=0

# Artifact copies keep at most this many bytes (20 MiB, as the tap does).
_runlog_artifact_max_default=20971520

# The jq `redact` def both jq paths share. Every pattern applies
# case-insensitively ("gi"), as in runlog.ts; see redact-patterns.md.
# shellcheck disable=SC2016
_runlog_jq_redact='def redact($p): reduce $p[] as $r (.;
  gsub($r.regex; "[redacted:\($r.kind)]"; "gi"));'

# The jq program behind every line. `redact` applies each shared pattern,
# `cut` keeps 512 characters, and a line over 4,095 bytes falls back to
# the common fields plus `truncated: true`. Positional args are KEY=VAL
# (string) or KEY:=JSON (raw, kept as a string if it doesn't parse).
# shellcheck disable=SC2016
_runlog_jq_line="${_runlog_jq_redact}"'
def cut: if length > 512 then .[:512] + "[cut]" else . end;
def clean: walk(if type == "string" then redact($pats[0]) | cut else . end);
def ts: ($ms / 1000 | floor | strftime("%Y-%m-%dT%H:%M:%S")) + "."
  + (($ms % 1000) + 1000 | tostring | .[1:]) + "Z";
({v: 1, ts: ts, source: $source, run_id: $run_id,
  parent_run_id: (if $parent == "" then null else $parent end),
  root_run_id: $root, tool: $tool}
  + (if $event == "" then {} else {event: $event} end)) as $common
| (reduce ($ARGS.positional[]
    | capture("^(?<k>[^=]*?)(?<op>:?=)(?<v>.*)$"; "p")
    | select(.k != "")) as $m ({};
    . + {($m.k): (if $m.op == ":=" then ($m.v | try fromjson catch $m.v)
      else $m.v end)})) as $own
| ($common + ($own | with_entries(select(.key as $k
    | $common | has($k) | not)))) | clean | tojson
| if utf8bytelength <= 4095 then .
  else $common + {truncated: true} | clean | tojson end
'

# _runlog_fail REASON: turns the writer off for the rest of this process.
# File writes stop; with KEEP_PRINT=1 the stdout copy keeps going, since
# printing doesn't depend on the file.
_runlog_fail() {
  local -r reason="${1:-unknown error}"
  local -r keep_print="${2:-0}"
  if [[ "${BOKU_RUNLOG_DEBUG:-}" == 1 && "${_runlog_broken}" != 1 ]]; then
    printf 'runlog: off: %s\n' "$reason" >&2 || true
  fi
  _runlog_broken=1
  _runlog_file_on=0
  if [[ "$keep_print" != 1 ]]; then
    _runlog_on=0
  fi
  return 0
}

# _runlog_now: sets _runlog_ms to the epoch time in ms, without a fork
# when bash has EPOCHREALTIME.
_runlog_now() {
  local -r rt="${EPOCHREALTIME:-}"
  local sec frac
  if [[ "$rt" =~ ^([0-9]+)[.,]([0-9]{3}) ]]; then
    sec="${BASH_REMATCH[1]}"
    frac="${BASH_REMATCH[2]}"
    _runlog_ms=$(( sec * 1000 + 10#$frac ))
  else
    sec="$(date +%s 2>/dev/null)" || sec=0
    [[ "$sec" =~ ^[0-9]+$ ]] || sec=0
    _runlog_ms=$(( sec * 1000 ))
  fi
  return 0
}

# _runlog_build EVENT [KEY=VAL ...]: sets _runlog_line to one JSON line
# stamped now, or returns 1. An empty EVENT leaves out the `event` field.
_runlog_build() {
  local -r event="${1:-}"
  shift || true
  _runlog_now
  _runlog_build_at "$_runlog_ms" "$event" "$@"
}

# _runlog_build_at MS EVENT [KEY=VAL ...]: _runlog_build with a set time.
_runlog_build_at() {
  local -r ms="${1:-0}" event="${2:-}"
  shift 2 || true
  _runlog_line=""
  local -a args=()
  _runlog_precut "$@"
  local line
  line="$(jq -nr \
    --slurpfile pats "${_runlog_patterns:-}" \
    --argjson ms "$ms" \
    --arg source "dotfiles" \
    --arg run_id "${_runlog_run_id:-}" \
    --arg parent "${_runlog_parent:-}" \
    --arg root "${_runlog_root:-}" \
    --arg tool "${_runlog_tool:-}" \
    --arg event "$event" \
    "$_runlog_jq_line" --args -- ${args[@]+"${args[@]}"} 2>/dev/null)" \
    || line=""
  if [[ -z "$line" ]]; then
    _runlog_fail "jq could not build a line"
    return 1
  fi
  _runlog_line="$line"
  return 0
}

# _runlog_precut [ARG...]: sets the caller's `args` to ARGs with long
# values shortened in bash first. One exec argument can't pass 128 KiB, so
# a huge msg would otherwise stop jq. KEY=VAL keeps 4,096 characters, well
# past jq's 512-character cut; KEY:=JSON keeps 65,536.
_runlog_precut() {
  args=()
  local arg
  for arg in "$@"; do
    if [[ "$arg" =~ ^[^=]*:= ]]; then
      args+=("${arg:0:65536}")
    else
      args+=("${arg:0:4096}")
    fi
  done
  return 0
}

# _runlog_emit: prints _runlog_line when asked and appends it to the run
# file with one printf, so a line up to 4 KiB lands in one write().
_runlog_emit() {
  if [[ "${_runlog_stdout}" == 1 ]]; then
    printf '%s\n' "$_runlog_line" 2>/dev/null || true
  fi
  if [[ "${_runlog_file_on}" == 1 ]]; then
    { printf '%s\n' "$_runlog_line" >>"${_runlog_run_file:-}"; } \
      2>/dev/null || _runlog_fail "cannot append to the run file" 1
  fi
  return 0
}

# _runlog_mkdir DIR: creates DIR with mode 0700 unless it exists.
_runlog_mkdir() {
  local -r dir="${1:-}"
  [[ -n "$dir" ]] || return 1
  [[ -d "$dir" ]] && return 0
  mkdir -m 700 -- "$dir" 2>/dev/null || [[ -d "$dir" ]]
}

# _runlog_new_id TOOL: sets _runlog_run_id to <yymmddTHHMMSSZ>-<tool>-<hex4>
# and _runlog_day to its yymmdd day folder name. The tool part keeps
# [A-Za-z0-9_.-], up to 40 characters, so the id is a safe file name.
_runlog_new_id() {
  local tool="${1:-run}"
  tool="${tool//[^A-Za-z0-9_.-]/-}"
  tool="${tool:0:40}"
  [[ -n "$tool" ]] || tool="run"
  local stamp=""
  TZ=UTC0 printf -v stamp '%(%y%m%dT%H%M%SZ)T' \
    "$(( _runlog_ms / 1000 ))" 2>/dev/null || stamp=""
  [[ "$stamp" =~ ^[0-9]{6}T[0-9]{6}Z$ ]] || return 1
  local hex=""
  printf -v hex '%04x' "$(( ((RANDOM << 1) ^ RANDOM) & 0xffff ))" \
    2>/dev/null || hex="0000"
  _runlog_run_id="${stamp}-${tool}-${hex}"
  _runlog_day="${stamp:0:6}"
  return 0
}

# _runlog_open_files: creates the day folder and claims a new run file
# with an exclusive create (mode 0600), picking a new id on a clash.
_runlog_open_files() {
  local -r home="${BOKU_HOME:-${HOME:-}/.boku}"
  [[ -n "${HOME:-}" || -n "${BOKU_HOME:-}" ]] || return 1
  _runlog_mkdir "$home" || return 1
  _runlog_mkdir "$home/runs" || return 1
  local try file
  for try in 1 2 3 4 5 6 7 8; do
    if [[ "$try" != 1 ]]; then
      _runlog_new_id "${_runlog_tool:-}" || return 1
    fi
    _runlog_mkdir "$home/runs/${_runlog_day}" || return 1
    file="$home/runs/${_runlog_day}/${_runlog_run_id}.jsonl"
    if ( umask 077 && set -o noclobber && : >"$file" ) 2>/dev/null; then
      _runlog_runs_dir="$home/runs"
      _runlog_run_file="$file"
      _runlog_run_dir="${file%.jsonl}"
      return 0
    fi
    [[ -e "$file" ]] || return 1
  done
  return 1
}

# _runlog_pid_start: prints field 22 of /proc/$$/stat (start time in clock
# ticks), or "null" off Linux. Fields count from after the ")" that ends
# the command name, which may itself hold spaces.
_runlog_pid_start() {
  local stat=""
  stat="$(cat "/proc/$$/stat" 2>/dev/null)" || stat=""
  if [[ -z "$stat" ]]; then
    printf 'null'
    return 0
  fi
  local -a fields=()
  read -r -a fields <<<"${stat##*) }" || true
  # fields[0] is field 3 (state), so field 22 is fields[19].
  local -r value="${fields[19]:-}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf 'null'
  fi
  return 0
}

# runlog_start TOOL [ARG...]: starts this process's run and writes its
# start event. Call it after argument parsing so --help logs nothing.
runlog_start() {
  [[ "${_runlog_on}" == 1 ]] && return 0
  _runlog_tool="${1:-run}"
  shift || true

  # Printing is per process: take the flag and keep it from children.
  _runlog_stdout=0
  if [[ -n "${BOKU_RUNLOG_STDOUT:-}" && "${BOKU_RUNLOG_STDOUT:-}" != 0 ]]
  then
    _runlog_stdout=1
  fi
  unset BOKU_RUNLOG_STDOUT || true

  # Link to the run that launched us; re-export only once active.
  _runlog_parent="${BOKU_RUN_ID:-}"
  _runlog_root="${BOKU_ROOT_RUN_ID:-${_runlog_parent}}"
  unset BOKU_RUN_ID BOKU_ROOT_RUN_ID || true

  _runlog_file_on=1
  if [[ "${BOKU_RUNLOG:-}" == 0 || "${_runlog_broken}" == 1 ]]; then
    _runlog_file_on=0
  fi
  if [[ "${_runlog_file_on}" != 1 && "${_runlog_stdout}" != 1 ]]; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    _runlog_fail "jq not found"
    return 0
  fi
  # Never write unredacted: no patterns file, no run.
  _runlog_patterns="${_runlog_lib_dir}/redact-patterns.json"
  if [[ ! -r "$_runlog_patterns" ]]; then
    _runlog_fail "cannot read $_runlog_patterns"
    return 0
  fi

  _runlog_now
  _runlog_start_ms="$_runlog_ms"
  if ! _runlog_new_id "$_runlog_tool"; then
    _runlog_fail "cannot make a run id"
    return 0
  fi
  if [[ "${_runlog_file_on}" == 1 ]] && ! _runlog_open_files; then
    _runlog_fail "cannot create the run file under BOKU_HOME" 1
  fi
  [[ -n "${_runlog_root}" ]] || _runlog_root="${_runlog_run_id}"
  _runlog_warns=0
  _runlog_errors=0
  _runlog_agent_cli=""
  _runlog_agent_session=""
  _runlog_on=1

  local argv_json host boot_id rev
  local -a args=()
  _runlog_precut "$@"
  argv_json="$(jq -nc '$ARGS.positional' \
    --args -- ${args[@]+"${args[@]}"} 2>/dev/null)" \
    || argv_json=""
  [[ -n "$argv_json" ]] || argv_json="[]"
  host="${HOSTNAME:-}"
  [[ -n "$host" ]] || host="$(uname -n 2>/dev/null)" || host=""
  boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" \
    || boot_id=""
  rev=""
  if [[ -n "$_runlog_lib_dir" ]]; then
    rev="$(git -C "$_runlog_lib_dir" rev-parse --short HEAD 2>/dev/null)" \
      || rev=""
  fi

  local -a fields=(
    "argv:=$argv_json"
    "cwd=${PWD:-}"
    "host=$host"
    "pid:=$$"
    "pid_start:=$(_runlog_pid_start)"
  )
  if [[ -n "$boot_id" ]]; then
    fields+=("boot_id=$boot_id")
  else
    fields+=("boot_id:=null")
  fi
  if [[ -n "$rev" ]]; then
    fields+=("rev=$rev")
  else
    fields+=("rev:=null")
  fi

  _runlog_build_at "$_runlog_start_ms" start "${fields[@]}" || return 0
  _runlog_emit
  if [[ "${_runlog_file_on}" == 1 ]]; then
    export BOKU_RUN_ID="$_runlog_run_id"
    export BOKU_ROOT_RUN_ID="$_runlog_root"
  fi
  return 0
}

# runlog_active: 0 if this process's run started and is writing its file.
runlog_active() {
  [[ "${_runlog_on}" == 1 && "${_runlog_file_on}" == 1 ]]
}

# runlog_event KIND [KEY=VAL | KEY:=JSON ...]: writes one event. `warn`
# and `error` count toward end; `agent` fills the index's agent field.
runlog_event() {
  [[ "${_runlog_on}" == 1 ]] || return 0
  local -r kind="${1:-event}"
  shift || true
  case "$kind" in
    warn) _runlog_warns=$(( ${_runlog_warns:-0} + 1 )) ;;
    error) _runlog_errors=$(( ${_runlog_errors:-0} + 1 )) ;;
    agent)
      local arg
      for arg in "$@"; do
        case "$arg" in
          cli=*) _runlog_agent_cli="${arg#cli=}" ;;
          session_id=*) _runlog_agent_session="${arg#session_id=}" ;;
        esac
      done
      ;;
  esac
  _runlog_build "$kind" "$@" || return 0
  _runlog_emit
  return 0
}

# runlog_step NAME CMD [ARG...]: runs an external command, logs a step
# with `cmd`, `exit`, and `dur_ms`, and returns the command's status.
# Wrap external commands only; functions and `source` run unwrapped.
runlog_step() {
  local -r name="${1:-step}"
  shift || true
  local rc=0 t0
  _runlog_now
  t0="$_runlog_ms"
  "$@" || rc=$?
  if [[ "${_runlog_on}" == 1 ]]; then
    _runlog_now
    runlog_event step name="$name" cmd="$*" exit:="$rc" \
      dur_ms:="$(( _runlog_ms - t0 ))" || true
  fi
  return "$rc"
}

# runlog_dir: prints the run's blob folder, creating it (0700). Returns 1
# and prints nothing while the run isn't active.
runlog_dir() {
  runlog_active || return 1
  if ! _runlog_mkdir "${_runlog_run_dir:-}"; then
    _runlog_fail "cannot create the run folder" 1
    return 1
  fi
  printf '%s\n' "$_runlog_run_dir" || true
  return 0
}

# runlog_file: prints the run's events file. Returns 1 while inactive.
runlog_file() {
  runlog_active || return 1
  printf '%s\n' "$_runlog_run_file" || true
  return 0
}

# _runlog_artifact_name KIND SRC: prints the file name an artifact gets.
# The kind's last "-" becomes "." (remerge-diff -> remerge.diff); a kind
# without "-" takes SRC's extension, if any (prompt + x.md -> prompt.md).
_runlog_artifact_name() {
  local kind="${1:-artifact}"
  local -r src="${2:-}"
  kind="${kind//[^A-Za-z0-9_.-]/-}"
  kind="${kind##.}"
  [[ -n "$kind" ]] || kind="artifact"
  if [[ "$kind" == *-* ]]; then
    printf '%s.%s' "${kind%-*}" "${kind##*-}"
    return 0
  fi
  local -r base="${src##*/}"
  if [[ "$base" == ?*.* && "${base##*.}" =~ ^[A-Za-z0-9]+$ ]]; then
    printf '%s.%s' "$kind" "${base##*.}"
  else
    printf '%s' "$kind"
  fi
  return 0
}

# _runlog_redact_file FILE: redacts FILE in place, with `boku-runs
# redact-file` when it's on PATH and works, else the shared patterns
# through jq. A broken boku-runs must not cost the artifact.
_runlog_redact_file() {
  local -r file="${1:-}"
  if command -v boku-runs >/dev/null 2>&1 \
    && boku-runs redact-file "$file" >/dev/null 2>&1; then
    return 0
  fi
  local -r out="${file}.redact"
  ( umask 077 && : >"$out" ) 2>/dev/null || return 1
  if jq -Rsj --slurpfile pats "${_runlog_patterns:-}" \
    "${_runlog_jq_redact} redact(\$pats[0])" \
    <"$file" >"$out" 2>/dev/null && mv -f -- "$out" "$file" 2>/dev/null
  then
    return 0
  fi
  rm -f -- "$out" 2>/dev/null || true
  return 1
}

# runlog_artifact KIND FILE: copies FILE into the run folder, capped at
# BOKU_RUNLOG_ARTIFACT_MAX bytes (default 20 MiB) and redacted, then logs
# an `artifact` event. A capped copy ends at its last full line, so no
# token is left half cut. A FILE already in the run folder is replaced.
runlog_artifact() {
  runlog_active || return 0
  local -r kind="${1:-artifact}" src="${2:-}"
  if [[ -z "$src" || ! -f "$src" || ! -r "$src" ]]; then
    runlog_event warn code=artifact-missing msg="$kind: $src" || true
    return 0
  fi
  local max="${BOKU_RUNLOG_ARTIFACT_MAX:-$_runlog_artifact_max_default}"
  [[ "$max" =~ ^[0-9]+$ ]] || max="$_runlog_artifact_max_default"
  local dir name dest tmp size truncated=false bytes sha
  dir="$(runlog_dir)" || return 0
  name="$(_runlog_artifact_name "$kind" "$src")" || name="$kind"
  dest="$dir/$name"
  tmp="$(mktemp "$dir/.artifact.XXXXXX" 2>/dev/null)" || tmp=""
  if [[ -z "$tmp" ]]; then
    _runlog_fail "cannot create an artifact temp file" 1
    return 0
  fi
  size="$(wc -c <"$src" 2>/dev/null)" || size=""
  size="${size//[^0-9]/}"
  if [[ -n "$size" ]] && (( size > max )); then
    truncated=true
    head -c "$max" -- "$src" >"$tmp" 2>/dev/null || truncated=error
    # Drop the partial last line so a cut token can't leak.
    local last=""
    last="$(tail -c 1 -- "$tmp" 2>/dev/null; printf x)" || last=""
    if [[ "$truncated" == true && "$last" != $'\nx' ]]; then
      { ( umask 077 && : >"$tmp.cut" ) \
        && LC_ALL=C awk '{ if (NR > 1) print prev; prev = $0 }' "$tmp" \
        >"$tmp.cut" && mv -f -- "$tmp.cut" "$tmp"; } 2>/dev/null \
        || truncated=error
    fi
  else
    cat -- "$src" >"$tmp" 2>/dev/null || truncated=error
  fi
  if [[ "$truncated" == error ]] || ! _runlog_redact_file "$tmp" \
    || ! mv -f -- "$tmp" "$dest" 2>/dev/null; then
    rm -f -- "$tmp" "$tmp.cut" 2>/dev/null || true
    # One lost artifact is worth a warning, not the rest of the run's log.
    runlog_event warn code=artifact-failed msg="cannot save artifact $kind" \
      || true
    return 0
  fi
  chmod 600 -- "$dest" 2>/dev/null || true
  # A source inside the run folder is now replaced by its redacted copy.
  if [[ "$src" == "$dir"/* && "$src" != "$dest" ]]; then
    rm -f -- "$src" 2>/dev/null || true
  fi
  bytes="$(wc -c <"$dest" 2>/dev/null)" || bytes=""
  bytes="${bytes//[^0-9]/}"
  sha="$(sha256sum -- "$dest" 2>/dev/null \
    || shasum -a 256 -- "$dest" 2>/dev/null)" || sha=""
  sha="${sha%% *}"
  local -a fields=("kind=$kind" "path=$name" "truncated:=$truncated")
  fields+=("bytes:=${bytes:-null}")
  if [[ -n "$sha" ]]; then
    fields+=("sha256=$sha")
  else
    fields+=("sha256:=null")
  fi
  runlog_event artifact "${fields[@]}" || true
  return 0
}

# _runlog_status_for EXIT: prints ok for 0, stopped for 2-5, else failed.
_runlog_status_for() {
  case "${1:-}" in
    0) printf 'ok' ;;
    2 | 3 | 4 | 5) printf 'stopped' ;;
    *) printf 'failed' ;;
  esac
  return 0
}

# _runlog_count_file WARNS_VAR ERRORS_VAR: sets the named variables to the
# run file's `warn` and `error` line counts, or returns 1 and leaves them.
# The file holds events from subshells and from the tap process, which
# this process's counters never see.
_runlog_count_file() {
  runlog_active || return 1
  local counts=""
  # shellcheck disable=SC2016
  counts="$(jq -Rrn '[inputs | fromjson? | objects | .event] as $e
    | "\($e | map(select(. == "warn")) | length)"
      + " \($e | map(select(. == "error")) | length)"' \
    <"${_runlog_run_file:-}" 2>/dev/null)" || counts=""
  [[ "$counts" =~ ^([0-9]+)\ ([0-9]+)$ ]] || return 1
  printf -v "$1" '%s' "${BASH_REMATCH[1]}" || return 1
  printf -v "$2" '%s' "${BASH_REMATCH[2]}" || return 1
  return 0
}

# runlog_end EXIT [status=...]: writes end, then the run's line in the
# day's index.jsonl. An explicit status= wins over the exit-code mapping.
# `warns` and `errors` count the run file's lines, so subshells and the
# tap count too; this process's own counters are the fallback when the
# file can't be read. The run is finished afterwards; later calls do
# nothing.
runlog_end() {
  [[ "${_runlog_on}" == 1 ]] || return 0
  local code="${1:-}"
  shift || true
  [[ "$code" =~ ^[0-9]+$ ]] || code=""
  local status="" arg
  for arg in "$@"; do
    case "$arg" in
      status=?*) status="${arg#status=}" ;;
    esac
  done
  [[ -n "$status" ]] || status="$(_runlog_status_for "$code")"
  _runlog_now
  local -r dur=$(( _runlog_ms - ${_runlog_start_ms:-$_runlog_ms} ))
  local warns="${_runlog_warns:-0}" errors="${_runlog_errors:-0}"
  _runlog_count_file warns errors || true

  if _runlog_build_at "$_runlog_ms" end "exit:=${code:-null}" \
    "status=$status" "dur_ms:=$dur" "warns:=$warns" "errors:=$errors"
  then
    _runlog_emit
  fi

  if runlog_active; then
    local agent="null"
    if [[ -n "${_runlog_agent_cli:-}${_runlog_agent_session:-}" ]]; then
      agent="$(jq -nc --arg cli "${_runlog_agent_cli:-}" \
        --arg sid "${_runlog_agent_session:-}" \
        '{cli: $cli, session_id: (if $sid == "" then null else $sid end)}' \
        2>/dev/null)" || agent="null"
      [[ -n "$agent" ]] || agent="null"
    fi
    local -r index="${_runlog_runs_dir:-}/${_runlog_day:-}/index.jsonl"
    if _runlog_build_at "${_runlog_start_ms:-0}" "" \
      "dur_ms:=$dur" "exit:=${code:-null}" "status=$status" \
      "warns:=$warns" "errors:=$errors" "agent:=$agent"
    then
      { ( umask 077 && : >>"$index" ) \
        && printf '%s\n' "$_runlog_line" >>"$index"; } 2>/dev/null \
        || _runlog_fail "cannot append to index.jsonl" 1
    fi
  fi
  _runlog_on=0
  _runlog_file_on=0
  return 0
}


#!/usr/bin/env python3
"""ROS 2 log file introspection commands (L1–L4).

No live ROS 2 graph required — works on log files in ~/.ros/log/ (or
$ROS_LOG_DIR / $ROS_HOME/log).  Pure Python stdlib only; no rclpy dependency.

Log directory resolution order:
  1. $ROS_LOG_DIR  — if set
  2. $ROS_HOME/log — if $ROS_HOME is set
  3. ~/.ros/log    — default

Commands
--------
list-runs     Discover available log runs with metadata (newest-first).
query         Filter log entries by severity, node, time range, text/regex.
tail          Incremental tail — only entries since the last call.
node-summary  Per-node statistics for a run: totals, severity breakdown,
              top recurring messages.

Log-line format (rcl_logging_spdlog default):
  [SEVERITY] [TIMESTAMP] [NODE_NAME]: message text
  [SEVERITY] [TIMESTAMP]: message text  (no node context)

SEVERITY ∈ {DEBUG, INFO, WARN, WARNING, ERROR, FATAL, CRITICAL}.
TIMESTAMP is floating-point seconds since the Unix epoch.
"""

import collections
import datetime
import json
import os
import pathlib
import re
import sys
import time
from typing import Dict, Iterator, List, Optional

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
_SKILL_ROOT  = _SCRIPT_DIR.parent
_TAIL_STATE  = _SKILL_ROOT / ".artifacts" / "logs_tail_state.json"


def _log_dir() -> pathlib.Path:
    """Return the active ROS 2 log directory (respects env-var overrides)."""
    if "ROS_LOG_DIR" in os.environ:
        return pathlib.Path(os.environ["ROS_LOG_DIR"]).expanduser()
    if "ROS_HOME" in os.environ:
        return pathlib.Path(os.environ["ROS_HOME"]).expanduser() / "log"
    return pathlib.Path("~/.ros/log").expanduser()


# ---------------------------------------------------------------------------
# Log-line parser
# ---------------------------------------------------------------------------

# Matches two ROS 2 log formats:
#   [SEV] [TS] [NODE]: message   (with node context)
#   [SEV] [TS]: message          (no node context — colon immediately after timestamp)
_LINE_RE = re.compile(
    r'^\[(?P<severity>DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]\s+'
    r'\[(?P<ts>[0-9]+\.[0-9]+)\]'
    r'(?:'
    r'\s+\[(?P<node>[^\]]+)\]:\s*'    # variant 1: space + [node]:
    r'|'
    r':\s*'                            # variant 2: colon only (no node)
    r')'
    r'(?P<msg>.*)$'
)

_SEV_NORM: Dict[str, str] = {
    "DEBUG":    "DEBUG",
    "INFO":     "INFO",
    "WARN":     "WARN",
    "WARNING":  "WARN",
    "ERROR":    "ERROR",
    "FATAL":    "FATAL",
    "CRITICAL": "FATAL",
}

_SEV_RANK: Dict[str, int] = {
    "DEBUG": 0,
    "INFO":  1,
    "WARN":  2,
    "ERROR": 3,
    "FATAL": 4,
}


def _parse_line(line: str) -> Optional[dict]:
    """Parse one ROS 2 log line.  Returns ``None`` if the line is not a log entry."""
    m = _LINE_RE.match(line.rstrip())
    if not m:
        return None
    sev_raw = m.group("severity")
    sev     = _SEV_NORM.get(sev_raw, sev_raw)
    try:
        ts = float(m.group("ts"))
    except ValueError:
        ts = 0.0
    return {
        "severity":  sev,
        "timestamp": ts,
        "node":      m.group("node") or "",
        "message":   m.group("msg"),
    }


# ---------------------------------------------------------------------------
# Run discovery
# ---------------------------------------------------------------------------

def _iter_runs(log_dir: pathlib.Path) -> Iterator[dict]:
    """Yield run-metadata dicts for each run found in *log_dir*, newest first."""
    if not log_dir.exists():
        return
    entries = sorted(
        log_dir.iterdir(),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for entry in entries:
        if not entry.is_dir() or entry.name == "latest":
            continue
        log_files = list(entry.glob("*.log"))
        if not log_files:
            continue
        newest_mtime = max(f.stat().st_mtime for f in log_files)
        size_bytes   = sum(f.stat().st_size for f in log_files)
        yield {
            "run_id":        entry.name,
            "path":          str(entry),
            "log_files":     len(log_files),
            "size_bytes":    size_bytes,
            "started_at":    datetime.datetime.fromtimestamp(
                                 entry.stat().st_mtime
                             ).isoformat(),
            "last_modified": datetime.datetime.fromtimestamp(
                                 newest_mtime
                             ).isoformat(),
        }


def _resolve_run(
    log_dir: pathlib.Path,
    run_id:  Optional[str],
) -> Optional[pathlib.Path]:
    """Return the path to the requested run directory.

    ``run_id=None`` or ``"latest"`` → follows the ``latest`` symlink if
    present, otherwise picks the most-recently modified run directory.
    """
    if run_id is None or run_id == "latest":
        latest_link = log_dir / "latest"
        if latest_link.is_symlink():
            target = latest_link.resolve()
            if target.is_dir():
                return target
        # Fallback: most recently modified run that has log files
        candidates = [
            p for p in log_dir.iterdir()
            if p.is_dir() and p.name != "latest" and list(p.glob("*.log"))
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda p: p.stat().st_mtime)
    else:
        p = log_dir / run_id
        return p if p.is_dir() else None


# ---------------------------------------------------------------------------
# Log-file iteration
# ---------------------------------------------------------------------------

def _iter_log_entries(
    run_dir: pathlib.Path,
    offsets: Optional[Dict[str, int]] = None,
) -> Iterator[dict]:
    """Yield parsed log entries from every ``*.log`` file in *run_dir*.

    *offsets*: optional ``{filepath_str: byte_offset}`` dict.  Each file is
    seeked to its recorded offset before reading.  The dict is updated
    **in-place** with the new end-of-file offset so the caller can persist
    state for incremental tailing.
    """
    for log_file in sorted(run_dir.glob("*.log")):
        path_str     = str(log_file)
        start_offset = (offsets or {}).get(path_str, 0)
        try:
            with open(log_file, "r", encoding="utf-8", errors="replace") as fh:
                fh.seek(start_offset)
                for line in fh:
                    entry = _parse_line(line)
                    if entry is not None:
                        entry["file"] = log_file.name
                        yield entry
                if offsets is not None:
                    offsets[path_str] = fh.tell()
        except (OSError, PermissionError):
            continue


# ---------------------------------------------------------------------------
# Time-filter helpers
# ---------------------------------------------------------------------------

def _parse_time_filter(value: str) -> Optional[float]:
    """Convert a time-filter string to an epoch timestamp.

    Accepted formats:
    - ``"-30s"`` / ``"-5m"`` / ``"-2h"``  →  relative to now
    - ``"1710000000.0"``                   →  epoch seconds (float)
    - ``"2024-03-14T10:30:00"``            →  ISO 8601 datetime
    - ``"2024-03-14 10:30:00"``            →  space-separated datetime
    - ``"2024-03-14"``                     →  date only (start of day)

    Returns ``None`` if *value* is empty or unparseable.
    """
    if not value:
        return None
    m = re.match(r'^-(\d+(?:\.\d+)?)([smh])$', value.strip())
    if m:
        amount = float(m.group(1))
        mult   = {"s": 1.0, "m": 60.0, "h": 3600.0}[m.group(2)]
        return time.time() - amount * mult
    try:
        return float(value)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(value, fmt).timestamp()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Output helper (no rclpy dependency)
# ---------------------------------------------------------------------------

def _output(data: dict) -> None:
    """Print *data* as indented JSON to stdout."""
    print(json.dumps(data, indent=2, default=str))


# ---------------------------------------------------------------------------
# L1 — list-runs
# ---------------------------------------------------------------------------

def cmd_logs_list_runs(args) -> None:
    """Discover available ROS 2 log runs in the log directory.

    Scans the log directory for subdirectories that contain ``*.log`` files
    and returns them newest-first.

    Output keys:
      log_dir   — resolved log directory
      run_count — total number of runs found
      runs      — list of run metadata objects (run_id, path, log_files,
                  size_bytes, started_at, last_modified)
      truncated — present and ``true`` when ``--limit`` was applied
      limit     — the cap applied (when truncated is true)
    """
    log_dir = _log_dir()
    if getattr(args, "log_dir", None):
        log_dir = pathlib.Path(args.log_dir).expanduser()

    if not log_dir.exists():
        _output({
            "log_dir":   str(log_dir),
            "run_count": 0,
            "runs":      [],
            "hint": "Log directory does not exist. Has ROS 2 been run yet?",
        })
        return

    runs  = list(_iter_runs(log_dir))
    limit = getattr(args, "limit", 20) or 20

    if limit > 0 and len(runs) > limit:
        shown     = runs[:limit]
        truncated = True
    else:
        shown     = runs
        truncated = False

    result = {
        "log_dir":   str(log_dir),
        "run_count": len(runs),
        "runs":      shown,
    }
    if truncated:
        result["truncated"] = True
        result["limit"]     = limit
    _output(result)


# ---------------------------------------------------------------------------
# L2 — query
# ---------------------------------------------------------------------------

def cmd_logs_query(args) -> None:
    """Query log entries in a run with multi-dimensional filters.

    Filter dimensions:
    - ``--severity`` (min level)         — DEBUG | INFO | WARN | ERROR | FATAL
    - ``--node``     (substring match)   — node name to filter by
    - ``--after``    (time lower bound)  — "-30s", "-5m", epoch float, ISO
    - ``--before``   (time upper bound)  — same formats as --after
    - ``--text``     (substring match)   — plain text substring in message
    - ``--regex``    (regex match)       — Python regex applied to message
    - ``--max``      (result cap)        — default 200

    Output keys:
      run_id        — run being queried
      run_path      — resolved path
      total_matched — entries that passed all filters (before --max)
      entries       — matching entries (capped at --max)
      filters       — active filter summary
      truncated     — true when total_matched > max
      hint          — present when truncated is true
    """
    log_dir = _log_dir()
    if getattr(args, "log_dir", None):
        log_dir = pathlib.Path(args.log_dir).expanduser()

    run_dir = _resolve_run(log_dir, getattr(args, "run", None))
    if run_dir is None:
        _output({
            "error":    "No log runs found",
            "log_dir":  str(log_dir),
            "hint":     "Run 'logs list-runs' to see available runs.",
        })
        return

    # --- build filters ---------------------------------------------------
    min_sev_raw  = (getattr(args, "severity", None) or "DEBUG").upper()
    min_sev      = _SEV_NORM.get(min_sev_raw, min_sev_raw)
    min_sev_rank = _SEV_RANK.get(min_sev, 0)

    node_filter  = getattr(args, "node",   None)
    text_filter  = getattr(args, "text",   None)
    regex_str    = getattr(args, "regex",  None)
    after_val    = getattr(args, "after",  None) or ""
    before_val   = getattr(args, "before", None) or ""
    max_entries  = getattr(args, "max",    200) or 200

    after_ts  = _parse_time_filter(after_val)
    before_ts = _parse_time_filter(before_val)

    compiled_re = None
    if regex_str:
        try:
            compiled_re = re.compile(regex_str, re.IGNORECASE)
        except re.error as exc:
            _output({"error": f"Invalid regex: {exc}", "pattern": regex_str})
            return

    # --- scan entries ----------------------------------------------------
    matched: List[dict] = []
    total_matched = 0

    for entry in _iter_log_entries(run_dir):
        if _SEV_RANK.get(entry["severity"], 0) < min_sev_rank:
            continue
        if node_filter and node_filter.lower() not in entry["node"].lower():
            continue
        if after_ts  is not None and entry["timestamp"] < after_ts:
            continue
        if before_ts is not None and entry["timestamp"] > before_ts:
            continue
        if text_filter and text_filter.lower() not in entry["message"].lower():
            continue
        if compiled_re and not compiled_re.search(entry["message"]):
            continue

        total_matched += 1
        if len(matched) < max_entries:
            matched.append(entry)

    # add human-readable ISO timestamps
    for e in matched:
        if e["timestamp"] > 0:
            try:
                e["time_iso"] = datetime.datetime.fromtimestamp(
                    e["timestamp"]
                ).isoformat()
            except (OSError, OverflowError, ValueError):
                pass

    # --- build result ----------------------------------------------------
    active_filters: dict = {"severity": min_sev}
    if node_filter:
        active_filters["node"]  = node_filter
    if text_filter:
        active_filters["text"]  = text_filter
    if regex_str:
        active_filters["regex"] = regex_str
    if after_ts is not None:
        active_filters["after"] = datetime.datetime.fromtimestamp(after_ts).isoformat()
    if before_ts is not None:
        active_filters["before"] = datetime.datetime.fromtimestamp(before_ts).isoformat()

    result: dict = {
        "run_id":        run_dir.name,
        "run_path":      str(run_dir),
        "total_matched": total_matched,
        "entries":       matched,
        "filters":       active_filters,
    }
    if total_matched > max_entries:
        result["truncated"] = True
        result["max"]       = max_entries
        result["hint"] = (
            f"Only first {max_entries} entries shown. "
            "Use --max N to increase the cap or tighten your filters."
        )
    _output(result)


# ---------------------------------------------------------------------------
# L3 — tail
# ---------------------------------------------------------------------------

def cmd_logs_tail(args) -> None:
    """Incremental log tail — return only new entries since the last call.

    Persists per-file byte offsets in ``.artifacts/logs_tail_state.json``.
    On first call (or ``--reset``), seeks to a point that yields
    ``--initial-lines`` lines from the end of each file (default: 50).

    Calling ``logs tail`` repeatedly while the robot runs produces a live
    rolling view without re-reading the entire log.

    Output keys:
      run_id       — run being tailed
      run_path     — resolved path
      new_entries  — list of new entries (may be empty if nothing changed)
      entry_count  — number of new entries returned
      state_saved  — true if the offset state file was updated successfully
    """
    log_dir = _log_dir()
    if getattr(args, "log_dir", None):
        log_dir = pathlib.Path(args.log_dir).expanduser()

    run_dir = _resolve_run(log_dir, getattr(args, "run", None))
    if run_dir is None:
        _output({
            "error":   "No log runs found",
            "log_dir": str(log_dir),
            "hint":    "Run 'logs list-runs' to see available runs.",
        })
        return

    run_id        = run_dir.name
    reset         = getattr(args, "reset", False)
    initial_lines = getattr(args, "initial_lines", 50) or 50

    # --- load persisted state -------------------------------------------
    state: dict = {}
    if not reset and _TAIL_STATE.exists():
        try:
            state = json.loads(_TAIL_STATE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            state = {}

    # reset if run changed or --reset
    if reset or state.get("run_id") != run_id:
        state = {"run_id": run_id, "files": {}}
        # seed offsets so we return ~initial_lines from the tail of each file
        for log_file in sorted(run_dir.glob("*.log")):
            try:
                file_size  = log_file.stat().st_size
                chunk_size = min(file_size, 8192)
                with open(log_file, "rb") as fh:
                    fh.seek(max(0, file_size - chunk_size))
                    chunk = fh.read()
                lines    = chunk.decode("utf-8", errors="replace").split("\n")
                skip     = max(0, len(lines) - initial_lines)
                skipped_b = len("\n".join(lines[:skip]).encode("utf-8"))
                state["files"][str(log_file)] = (
                    max(0, file_size - chunk_size) + skipped_b
                )
            except OSError:
                state["files"][str(log_file)] = 0

    offsets: dict = state.setdefault("files", {})

    # --- collect new entries -------------------------------------------
    new_entries: List[dict] = []
    for entry in _iter_log_entries(run_dir, offsets):
        if entry["timestamp"] > 0:
            try:
                entry["time_iso"] = datetime.datetime.fromtimestamp(
                    entry["timestamp"]
                ).isoformat()
            except (OSError, OverflowError, ValueError):
                pass
        new_entries.append(entry)

    state["run_id"]    = run_id
    state["last_call"] = time.time()

    # --- persist state -------------------------------------------------
    state_saved = False
    try:
        _TAIL_STATE.parent.mkdir(parents=True, exist_ok=True)
        _TAIL_STATE.write_text(json.dumps(state, indent=2), encoding="utf-8")
        state_saved = True
    except OSError:
        pass

    _output({
        "run_id":      run_id,
        "run_path":    str(run_dir),
        "new_entries": new_entries,
        "entry_count": len(new_entries),
        "state_saved": state_saved,
    })


# ---------------------------------------------------------------------------
# L4 — node-summary
# ---------------------------------------------------------------------------

def cmd_logs_node_summary(args) -> None:
    """Per-node statistics for a log run.

    For each node that produced log output, computes:
    - Total message count
    - Severity breakdown (DEBUG / INFO / WARN / ERROR / FATAL counts)
    - Top N most frequent message patterns (numbers/addresses normalised)
    - First and last message timestamps

    Output keys:
      run_id      — run analysed
      run_path    — resolved path
      node_count  — distinct nodes found
      nodes       — dict keyed by node name, each containing:
                    total, severity_counts, top_messages, first_ts, last_ts,
                    first_iso, last_iso
      global      — aggregate total and severity_counts across all nodes
    """
    log_dir = _log_dir()
    if getattr(args, "log_dir", None):
        log_dir = pathlib.Path(args.log_dir).expanduser()

    run_dir = _resolve_run(log_dir, getattr(args, "run", None))
    if run_dir is None:
        _output({
            "error":   "No log runs found",
            "log_dir": str(log_dir),
            "hint":    "Run 'logs list-runs' to see available runs.",
        })
        return

    top_n = getattr(args, "top", 5) or 5

    # per-node accumulators
    node_data: Dict[str, dict] = {}
    global_sev: Dict[str, int] = collections.defaultdict(int)
    global_total = 0

    # normalisation: strip volatile parts of messages to cluster variants
    _NORM_SUBS = [
        (re.compile(r'0x[0-9a-fA-F]+'),       '<hex>'),
        (re.compile(r'\b\d+\.\d+\b'),          '<float>'),
        (re.compile(r'\b\d{4,}\b'),            '<N>'),      # long integers only
    ]

    def _normalise(msg: str) -> str:
        result = msg
        for pat, repl in _NORM_SUBS:
            result = pat.sub(repl, result)
        return result.strip()

    for entry in _iter_log_entries(run_dir):
        node = entry["node"] or "(no node)"
        sev  = entry["severity"]
        ts   = entry["timestamp"]
        msg  = entry["message"]

        if node not in node_data:
            node_data[node] = {
                "total":           0,
                "severity_counts": {
                    "DEBUG": 0, "INFO": 0, "WARN": 0,
                    "ERROR": 0, "FATAL": 0,
                },
                "_msg_counts":     collections.defaultdict(int),
                "first_ts":        ts,
                "last_ts":         ts,
            }
        nd = node_data[node]
        nd["total"] += 1
        nd["severity_counts"][sev] = nd["severity_counts"].get(sev, 0) + 1
        nd["_msg_counts"][_normalise(msg)] += 1
        if ts < nd["first_ts"]:
            nd["first_ts"] = ts
        if ts > nd["last_ts"]:
            nd["last_ts"] = ts

        global_sev[sev] += 1
        global_total     += 1

    # build output
    nodes_out: dict = {}
    for node, nd in sorted(
        node_data.items(),
        key=lambda kv: kv[1]["total"],
        reverse=True,
    ):
        top_msgs = sorted(
            nd["_msg_counts"].items(),
            key=lambda kv: kv[1],
            reverse=True,
        )[:top_n]

        first_iso = last_iso = None
        try:
            if nd["first_ts"] > 0:
                first_iso = datetime.datetime.fromtimestamp(nd["first_ts"]).isoformat()
            if nd["last_ts"] > 0:
                last_iso  = datetime.datetime.fromtimestamp(nd["last_ts"]).isoformat()
        except (OSError, OverflowError, ValueError):
            pass

        nodes_out[node] = {
            "total":           nd["total"],
            "severity_counts": nd["severity_counts"],
            "top_messages":    [{"pattern": p, "count": c} for p, c in top_msgs],
            "first_ts":        nd["first_ts"],
            "last_ts":         nd["last_ts"],
            "first_iso":       first_iso,
            "last_iso":        last_iso,
        }

    _output({
        "run_id":     run_dir.name,
        "run_path":   str(run_dir),
        "node_count": len(node_data),
        "nodes":      nodes_out,
        "global": {
            "total":           global_total,
            "severity_counts": dict(global_sev),
        },
    })


# ---------------------------------------------------------------------------
# Guard: this module is not meant to be run directly
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import os as _os
    _mod = _os.path.basename(__file__)
    _cli = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "ros2_cli.py")
    print(
        f"[ros2-skill] '{_mod}' is an internal module — do not run it directly.\n"
        "Use the main entry point:\n"
        f"  python3 {_cli} <command> [subcommand] [args]\n"
        f"See all commands:  python3 {_cli} --help",
        file=sys.stderr,
    )
    sys.exit(1)

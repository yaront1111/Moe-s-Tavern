#!/usr/bin/env python3
"""ROS 2 bag commands.

Implements bag info by parsing the metadata.yaml file found in a bag directory.
No rclpy, rosbag2_py, or running ROS 2 graph is required — a bag is just a
directory containing a metadata.yaml and one or more storage files.

Other subcommands (record, play, convert) require long-running async process
management and will be added when subprocess delegation is permitted.
"""

import pathlib

from ros2_utils import output


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_metadata(bag_path: str) -> dict:
    """Load and return the parsed metadata.yaml for a bag.

    Accepts:
    - Path to a bag directory (metadata.yaml is discovered inside it).
    - Path to metadata.yaml directly.
    - Path to a storage file (.db3, .mcap) — metadata.yaml is looked up in
      the parent directory.

    Raises FileNotFoundError if metadata.yaml cannot be found.
    Raises ImportError if PyYAML is not installed.
    """
    try:
        import yaml
    except ImportError as exc:
        raise ImportError("PyYAML is required for bag info: pip install pyyaml") from exc

    path = pathlib.Path(bag_path).expanduser().resolve()

    if path.is_dir():
        metadata_file = path / "metadata.yaml"
    elif path.name == "metadata.yaml":
        metadata_file = path
    else:
        # Storage file or unknown — try the parent directory.
        metadata_file = path.parent / "metadata.yaml"

    if not metadata_file.exists():
        raise FileNotFoundError(
            f"metadata.yaml not found in '{metadata_file.parent}'. "
            "Provide the path to a bag directory that contains metadata.yaml."
        )

    with open(metadata_file, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _ns_to_sec(nanoseconds: int) -> float:
    """Convert nanoseconds to seconds, rounded to 9 decimal places."""
    return round(nanoseconds / 1_000_000_000, 9)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_bag_info(args):
    """Show metadata about a ROS 2 bag: duration, topics, message counts, storage format.

    Parses the bag directory's metadata.yaml without requiring rclpy or a live
    ROS 2 graph.  Works with sqlite3, MCAP, and any other storage backend.
    """
    try:
        raw = _parse_metadata(args.bag_path)

        # The top-level key is 'rosbag2_bagfile_information' in all known versions.
        # Fall back to the raw dict if a non-standard layout is encountered.
        info = raw.get("rosbag2_bagfile_information", raw)

        # ---- Duration -------------------------------------------------------
        duration_raw = info.get("duration", {})
        if isinstance(duration_raw, dict):
            duration_ns = int(duration_raw.get("nanoseconds", 0))
        else:
            duration_ns = int(duration_raw) if duration_raw else 0

        # ---- Start time -----------------------------------------------------
        start_raw = info.get("starting_time", {})
        if isinstance(start_raw, dict):
            start_ns = int(start_raw.get("nanoseconds_since_epoch", 0))
        else:
            start_ns = int(start_raw) if start_raw else 0

        # ---- Storage --------------------------------------------------------
        storage_identifier = info.get("storage_identifier", "unknown")
        compression_format = (info.get("compression_format") or "").strip()
        compression_mode   = (info.get("compression_mode")   or "").strip()

        # ---- Message count --------------------------------------------------
        message_count = int(info.get("message_count", 0))

        # ---- Topics ---------------------------------------------------------
        topics_raw = info.get("topics_with_message_count", [])
        topics = []
        for entry in topics_raw:
            # v5+: each entry has a nested 'topic_metadata' dict.
            # Some older/custom formats embed metadata directly in the entry.
            meta = entry.get("topic_metadata", entry)
            topics.append({
                "name":                 meta.get("name", ""),
                "type":                 meta.get("type", ""),
                "serialization_format": meta.get("serialization_format", "cdr"),
                "offered_qos_profiles": meta.get("offered_qos_profiles", ""),
                "message_count":        int(entry.get("message_count", 0)),
            })

        # Sort topics by name for stable output.
        topics.sort(key=lambda t: t["name"])

        # ---- Storage files --------------------------------------------------
        files_raw = info.get("files", [])
        files = [
            f.get("path", str(f)) if isinstance(f, dict) else str(f)
            for f in files_raw
        ]

        # ---- Result ---------------------------------------------------------
        result = {
            "bag_path":          str(pathlib.Path(args.bag_path).expanduser().resolve()),
            "storage_identifier": storage_identifier,
            "duration": {
                "nanoseconds": duration_ns,
                "seconds":     _ns_to_sec(duration_ns),
            },
            "starting_time": {
                "nanoseconds_since_epoch": start_ns,
            },
            "message_count": message_count,
            "topic_count":   len(topics),
            "topics":        topics,
        }
        if compression_format:
            result["compression_format"] = compression_format
            result["compression_mode"]   = compression_mode
        if files:
            result["files"] = files

        output(result)

    except FileNotFoundError as exc:
        output({
            "error": str(exc),
            "hint":  "Provide the path to a bag directory that contains metadata.yaml.",
        })
    except Exception as exc:
        output({"error": str(exc)})


if __name__ == "__main__":
    import sys
    import os
    _mod = os.path.basename(__file__)
    _cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ros2_cli.py")
    print(
        f"[ros2-skill] '{_mod}' is an internal module — do not run it directly.\n"
        "Use the main entry point:\n"
        f"  python3 {_cli} <command> [subcommand] [args]\n"
        f"See all commands:  python3 {_cli} --help",
        file=sys.stderr,
    )
    sys.exit(1)

#!/usr/bin/env python3
"""ROS 2 daemon management commands.

Delegates to ``ros2 daemon start/stop/status`` via subprocess so that the
commands work regardless of whether the ``ros2cli`` Python package is
importable from the current Python environment.

No live ROS 2 graph is required.  Domain ID is read from the
``ROS_DOMAIN_ID`` environment variable (default: 0).

Note: importing this module requires rclpy to be installed because the
``output`` helper is imported from ros2_utils, which validates the rclpy
environment at import time.  The daemon commands themselves make no rclpy
calls.
"""

import os
import subprocess

from ros2_utils import output


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_domain_id() -> int:
    """Return the active ROS domain ID (ROS_DOMAIN_ID env var, default 0)."""
    try:
        return int(os.environ.get("ROS_DOMAIN_ID", "0"))
    except (ValueError, TypeError):
        return 0


def _ros2_daemon(subcmd: str, domain_id: int) -> subprocess.CompletedProcess:
    """Run ``ros2 daemon <subcmd>`` with *domain_id* set in the environment."""
    env = {**os.environ, "ROS_DOMAIN_ID": str(domain_id)}
    return subprocess.run(
        ["ros2", "daemon", subcmd],
        capture_output=True, text=True, timeout=15, env=env,
    )


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_daemon_status(args):
    """Check whether the ROS 2 daemon is running.

    Delegates to ``ros2 daemon status``.  Output keys:

    * ``status``    – ``"running"`` or ``"not_running"``
    * ``domain_id`` – active ROS domain ID
    * ``output``    – raw text from the ros2 CLI
    """
    domain_id = None
    try:
        domain_id = _get_domain_id()
        proc = _ros2_daemon("status", domain_id)
        text = (proc.stdout + proc.stderr).strip()
        running = proc.returncode == 0 and "not running" not in text.lower()
        output({
            "status": "running" if running else "not_running",
            "domain_id": domain_id,
            "output": text,
        })
    except Exception as exc:
        output({"error": str(exc), "domain_id": domain_id if domain_id is not None else 0})


def cmd_daemon_start(args):
    """Start the ROS 2 daemon.

    Delegates to ``ros2 daemon start``.  Output keys:

    * ``status``    – ``"started"`` on success, ``"error"`` on failure
    * ``domain_id`` – active ROS domain ID
    * ``output``    – raw text from the ros2 CLI (success path)
    * ``detail``    – error detail from the ros2 CLI (error path)
    """
    domain_id = None
    try:
        domain_id = _get_domain_id()
        proc = _ros2_daemon("start", domain_id)
        text = (proc.stdout + proc.stderr).strip()
        if proc.returncode != 0:
            output({"status": "error", "detail": text, "domain_id": domain_id})
        else:
            output({"status": "started", "domain_id": domain_id, "output": text})
    except Exception as exc:
        output({"error": str(exc), "domain_id": domain_id if domain_id is not None else 0})


def cmd_daemon_stop(args):
    """Stop the ROS 2 daemon.

    Delegates to ``ros2 daemon stop``.  Output keys:

    * ``status``    – ``"stopped"`` on success, ``"error"`` on failure
    * ``domain_id`` – active ROS domain ID
    * ``output``    – raw text from the ros2 CLI (success path)
    * ``detail``    – error detail from the ros2 CLI (error path)
    """
    domain_id = None
    try:
        domain_id = _get_domain_id()
        proc = _ros2_daemon("stop", domain_id)
        text = (proc.stdout + proc.stderr).strip()
        if proc.returncode != 0:
            output({"status": "error", "detail": text, "domain_id": domain_id})
        else:
            output({"status": "stopped", "domain_id": domain_id, "output": text})
    except Exception as exc:
        output({"error": str(exc), "domain_id": domain_id if domain_id is not None else 0})


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

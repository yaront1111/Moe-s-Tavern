#!/usr/bin/env python3
"""Foxglove Bridge management commands.

Provides start / stop / status subcommands for the ``foxglove`` command
group.  Sessions are named ``launch_foxglove_bridge_port<N>`` so that
``launch restart`` and ``launch list`` continue to find them.

Package naming follows the standard ROS 2 apt convention across all
supported distros::

    ros-<distro>-foxglove-bridge

The active distro is resolved via :func:`~ros2_utils.get_ros_distro`
rather than reading ``$ROS_DISTRO`` directly, so the distro checker's
alphabetical-fallback logic handles future releases automatically.
"""

import os
from typing import Optional

from ros2_utils import (
    output,
    run_cmd,
    check_tmux,
    generate_session_name,
    session_exists,
    kill_session,
    check_session_alive,
    quote_path,
    save_session,
    get_session_metadata,
    delete_session_metadata,
    list_packages,
    package_exists,
    get_package_prefix,
    source_local_ws,
    get_ros_distro,
)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_FOXGLOVE_SESSION_PREFIX = "launch_foxglove_bridge_"


def _foxglove_session_name(port: int) -> str:
    """Return the tmux session name for a given port."""
    return generate_session_name("launch", "foxglove_bridge", f"port{port}")


def _get_active_foxglove_sessions() -> list[str]:
    """Return all tmux sessions that look like foxglove bridge sessions."""
    stdout, _, rc = run_cmd("tmux list-sessions -F '#{session_name}' 2>/dev/null")
    if rc != 0 or not stdout.strip():
        return []
    return [s for s in stdout.strip().split("\n")
            if s.startswith(_FOXGLOVE_SESSION_PREFIX)]


def _port_from_session(session_name: str) -> Optional[int]:
    """Extract port number from a session name, or ``None`` if unparseable."""
    suffix = session_name.removeprefix(_FOXGLOVE_SESSION_PREFIX)
    if suffix.startswith("port"):
        try:
            return int(suffix[4:])
        except ValueError:
            pass
    return None


def _is_port_bound(port: int) -> bool:
    """Return ``True`` if something is actively listening on *port*.

    Tries ``ss`` first (Linux), then ``lsof`` (macOS / fallback).
    """
    # ss: works on all modern Linux systems
    stdout, _, rc = run_cmd(f"ss -tlnp 2>/dev/null")
    if rc == 0:
        for line in stdout.splitlines():
            # Match lines like "LISTEN  0  128  0.0.0.0:8765  ..."
            if f":{port} " in line or f":{port}\t" in line or line.rstrip().endswith(f":{port}"):
                return True

    # lsof fallback (macOS / some Linux configs)
    _, _, rc2 = run_cmd(f"lsof -iTCP:{port} -sTCP:LISTEN 2>/dev/null")
    return rc2 == 0


def _find_launch_file(prefix: str) -> Optional[str]:
    """Search common install locations for ``foxglove_bridge_launch.xml``."""
    candidates = [
        os.path.join(prefix, "share", "foxglove_bridge", "launch", "foxglove_bridge_launch.xml"),
        os.path.join(prefix, "lib",   "foxglove_bridge", "launch", "foxglove_bridge_launch.xml"),
        os.path.join(prefix, "share", "foxglove_bridge", "foxglove_bridge_launch.xml"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


# ---------------------------------------------------------------------------
# Command implementations
# ---------------------------------------------------------------------------

def cmd_foxglove_start(args):
    """Launch foxglove_bridge in a dedicated tmux session.

    Resolves the correct apt package name for the active ROS 2 distro
    automatically (e.g. ``ros-kilted-foxglove-bridge`` on Kilted, or
    ``ros-lyrical-foxglove-bridge`` on Lyrical).
    """
    if not check_tmux():
        return output({
            "error": "tmux is not installed. Install with: sudo apt install tmux",
        })

    port = args.port
    ros_distro = get_ros_distro()   # uses distro-checker, not bare $ROS_DISTRO

    # Validate port range
    if not (1 <= port <= 65535):
        return output({
            "error": f"Invalid port: {port}",
            "suggestion": "Port must be between 1 and 65535",
        })

    # Check for an already-running session on this port
    session_name = _foxglove_session_name(port)
    if session_exists(session_name):
        is_alive = check_session_alive(session_name)
        port_bound = _is_port_bound(port)
        return output({
            "error": f"foxglove_bridge is already running on port {port}",
            "session": session_name,
            "status": "running" if is_alive else "crashed",
            "port_bound": port_bound,
            "connect_url": f"ws://localhost:{port}",
            "hint": (
                f"Use 'foxglove stop --port {port}' to stop it first, "
                f"or 'launch restart {session_name}' to restart."
            ),
        })

    # Resolve the foxglove_bridge package
    if not package_exists("foxglove_bridge", force_refresh=False):
        list_packages(force_refresh=True)
    if not package_exists("foxglove_bridge", force_refresh=False):
        install_cmd = (
            f"sudo apt install ros-{ros_distro}-foxglove-bridge"
            if ros_distro != "unknown"
            else "sudo apt install ros-<distro>-foxglove-bridge"
        )
        return output({
            "error": "Package 'foxglove_bridge' not found",
            "current_distro": ros_distro,
            "install": install_cmd,
            "alternative": (
                "git clone https://github.com/foxglove/ros2-foxglove-bridge.git\n"
                "  colcon build --packages-select foxglove_bridge"
            ),
        })

    # Locate launch file
    prefix = get_package_prefix("foxglove_bridge")
    launch_path = _find_launch_file(prefix)
    if not launch_path:
        install_cmd = (
            f"sudo apt install ros-{ros_distro}-foxglove-bridge"
            if ros_distro != "unknown"
            else "sudo apt install ros-<distro>-foxglove-bridge"
        )
        return output({
            "error": "Launch file 'foxglove_bridge_launch.xml' not found in foxglove_bridge package",
            "current_distro": ros_distro,
            "package_prefix": prefix,
            "suggestion": (
                f"The package may be built for a different distro. "
                f"Reinstall:\n  {install_cmd}"
            ),
        })

    # Build and run the launch command
    launch_cmd = f"ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:={port}"
    ws_path, ws_status = source_local_ws()

    if ws_status == "invalid":
        return output({
            "error": "ROS2_LOCAL_WS is set but the path does not exist",
            "suggestion": "Unset ROS2_LOCAL_WS or point it at a valid workspace",
        })

    warning = None
    if ws_status == "not_built":
        warning = "Local workspace found but not built — run 'colcon build' first."
    elif ws_status == "not_found":
        ws_path = None

    quoted_ws = quote_path(ws_path) if ws_path else None
    if quoted_ws:
        tmux_cmd = (
            f"tmux new-session -d -s {session_name} "
            f"'bash -c \"source {quoted_ws} && {launch_cmd}\" 2>&1'"
        )
    else:
        tmux_cmd = f"tmux new-session -d -s {session_name} '{launch_cmd} 2>&1'"

    _, stderr, rc = run_cmd(tmux_cmd, timeout=30)
    if rc != 0:
        return output({
            "error": f"Failed to start foxglove_bridge: {stderr}",
            "command": launch_cmd,
            "session": session_name,
        })

    is_alive = check_session_alive(session_name)
    status = "running" if is_alive else "crashed"

    result = {
        "success": True,
        "session": session_name,
        "command": launch_cmd,
        "port": port,
        "status": status,
        "distro": ros_distro,
        "connect_url": f"ws://localhost:{port}",
        "foxglove_studio": "https://app.foxglove.dev → Foxglove WebSocket",
    }
    if ws_path:
        result["workspace_sourced"] = ws_path
    if warning:
        result["warning"] = warning

    save_session(session_name, {
        "type": "foxglove",
        "port": port,
        "command": launch_cmd,
    })

    return output(result)


def cmd_foxglove_stop(args):
    """Stop a running foxglove_bridge session.

    If ``--port`` is given, only the session on that port is stopped.
    If omitted and exactly one session is running, it is stopped
    automatically.  If multiple sessions are running without a port
    filter, all names are listed and the command exits without killing
    anything (so the agent can choose).
    """
    if not check_tmux():
        return output({"error": "tmux is not installed"})

    port_filter = getattr(args, "port", None)
    sessions = _get_active_foxglove_sessions()

    if not sessions:
        return output({
            "success": True,
            "message": "No foxglove_bridge sessions are running",
            "stopped": [],
        })

    # Apply port filter
    if port_filter is not None:
        target_name = _foxglove_session_name(port_filter)
        if target_name not in sessions:
            return output({
                "error": f"No foxglove_bridge session found on port {port_filter}",
                "running_sessions": sessions,
            })
        to_stop = [target_name]
    elif len(sessions) == 1:
        to_stop = sessions
    else:
        # Multiple sessions — list them and ask the agent to choose
        return output({
            "error": "Multiple foxglove_bridge sessions are running — specify --port to stop one",
            "running_sessions": [
                {"session": s, "port": _port_from_session(s)} for s in sessions
            ],
            "hint": "foxglove stop --port <port>",
        })

    stopped = []
    failed = []
    for sname in to_stop:
        if kill_session(sname):
            delete_session_metadata(sname)
            stopped.append(sname)
        else:
            failed.append(sname)

    result: dict = {"success": not failed, "stopped": stopped}
    if failed:
        result["failed"] = failed
        result["hint"] = "Session may have already exited; check with 'foxglove status'"
    return output(result)


def cmd_foxglove_status(args):
    """Report the status of all running foxglove_bridge sessions.

    For each session, shows whether the tmux pane is alive, whether the
    WebSocket port is actually bound (bridge fully initialised), and the
    connection URL to paste into Foxglove Studio.
    """
    if not check_tmux():
        return output({"error": "tmux is not installed"})

    sessions = _get_active_foxglove_sessions()
    ros_distro = get_ros_distro()

    if not sessions:
        install_hint = (
            f"sudo apt install ros-{ros_distro}-foxglove-bridge"
            if ros_distro != "unknown"
            else "sudo apt install ros-<distro>-foxglove-bridge"
        )
        return output({
            "running": False,
            "bridges": [],
            "message": "No foxglove_bridge sessions are running",
            "start_hint": f"foxglove start [port]   (default port: 8765)",
            "install_hint": install_hint,
        })

    bridges = []
    for sname in sessions:
        port = _port_from_session(sname)
        alive = check_session_alive(sname)
        port_bound = _is_port_bound(port) if port is not None else False

        entry: dict = {
            "session": sname,
            "port": port,
            "tmux_alive": alive,
            "port_bound": port_bound,
        }
        if port is not None:
            entry["connect_url"] = f"ws://localhost:{port}"
            entry["foxglove_studio"] = "https://app.foxglove.dev → Foxglove WebSocket"

        if alive and port_bound:
            entry["status"] = "ready"
        elif alive and not port_bound:
            entry["status"] = "starting"   # bridge launched but port not yet open
        else:
            entry["status"] = "crashed"
            entry["hint"] = (
                f"Session '{sname}' exists but has no running process. "
                f"Use 'launch restart {sname}' or 'foxglove stop --port {port}' "
                f"then 'foxglove start {port}'."
            )

        bridges.append(entry)

    return output({
        "running": True,
        "bridges": bridges,
        "count": len(bridges),
    })


if __name__ == "__main__":
    import sys as _sys
    _mod = os.path.basename(__file__)
    _cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ros2_cli.py")
    print(
        f"[ros2-skill] '{_mod}' is an internal module — do not run it directly.\n"
        "Use the main entry point:\n"
        f"  python3 {_cli} <command> [subcommand] [args]\n"
        f"See all commands:  python3 {_cli} --help",
        file=_sys.stderr,
    )
    _sys.exit(1)

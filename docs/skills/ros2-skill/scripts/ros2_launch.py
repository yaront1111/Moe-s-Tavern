#!/usr/bin/env python3
"""ROS 2 launch commands for running launch files in tmux sessions."""

import json
import os
import shlex

from ros2_utils import (
    output,
    source_local_ws,
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
    list_sessions,
    kill_session_cmd,
    fuzzy_match,
)

# Foxglove bridge start is implemented in ros2_foxglove to keep that module
# self-contained.  cmd_launch_foxglove delegates here so that
# ``launch foxglove`` remains a supported alias.
from ros2_foxglove import cmd_foxglove_start as cmd_launch_foxglove  # noqa: E402


# Cache for launch arguments: {(package, launch_file): [args]}
_launch_args_cache = {}

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_param_str(params_str):
    """Parse comma-separated 'key:=value' (or 'key=value' / 'key:value') into
    a list of canonical 'key:=value' strings suitable as launch arguments."""
    if not params_str:
        return []
    result = []
    for pair in params_str.split(','):
        pair = pair.strip()
        if not pair:
            continue
        if ':=' in pair:
            result.append(pair)
        elif ':' in pair:
            k, v = pair.split(':', 1)
            result.append(f"{k.strip()}:={v.strip()}")
        elif '=' in pair:
            k, v = pair.split('=', 1)
            result.append(f"{k.strip()}:={v.strip()}")
        else:
            # No recognised separator — pass through unchanged so the arg
            # validator can report it rather than silently discarding it.
            result.append(pair)
    return result


def _load_preset(preset_name):
    """Load a named parameter preset from .presets/{name}.json.

    Returns (list_of_'key:=value'_strings, error_str_or_None).
    """
    presets_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '.presets')
    )
    preset_path = os.path.join(presets_dir, f"{preset_name}.json")
    if not os.path.exists(preset_path):
        return [], f"Preset '{preset_name}' not found at {preset_path}"
    try:
        with open(preset_path, 'r') as f:
            data = json.load(f)
        return [f"{k}:={v}" for k, v in data.items()], None
    except Exception as exc:
        return [], f"Failed to load preset '{preset_name}': {exc}"


def _find_duplicate_launch(package, launch_file_basename):
    """Return an existing session name if the same package+launch_file is
    already running, or None if not found."""
    sessions_result = list_sessions("launch_")
    for session_name in sessions_result.get("launch_sessions", []):
        metadata = get_session_metadata(session_name)
        if metadata and (
            metadata.get("package") == package
            and metadata.get("launch_file") == launch_file_basename
        ):
            return session_name
    return None


def _get_launch_arguments(package, launch_file):
    """Get available launch arguments from a launch file.
    
    Uses cache to avoid repeated calls.
    """
    cache_key = (package, launch_file)
    
    if cache_key in _launch_args_cache:
        return _launch_args_cache[cache_key]
    
    # Get the launch file path
    prefix = get_package_prefix(package)
    if not prefix:
        return []
    
    possible_paths = [
        os.path.join(prefix, "share", package, "launch", launch_file),
        os.path.join(prefix, "lib", package, "launch", launch_file),
        launch_file,
    ]
    
    launch_path = None
    for p in possible_paths:
        if os.path.exists(p):
            launch_path = p
            break
    
    if not launch_path:
        return []
    
    # Call --show-arguments to get available args
    cmd = f"ros2 launch {package} {os.path.basename(launch_path)} --show-arguments"
    stdout, stderr, rc = run_cmd(cmd, timeout=30)
    
    args = []
    if rc == 0 and stdout:
        # Parse --show-args output.  ROS 2 Humble+ format:
        #   Arguments for the launch file:
        #   'arg_name':
        #       default: 'value'
        #       description: '...'
        # Indented lines are metadata; only unindented non-header lines are arg names.
        for line in stdout.split('\n'):
            # Use the RAW line for the indentation check (before any strip).
            if not line or line[0] in (' ', '\t'):
                continue
            stripped = line.strip()
            # Remove surrounding quotes and trailing colon: 'arg': → arg
            arg = stripped.rstrip(':').strip("'\"")
            # Skip the section header line
            if arg and 'Arguments for the launch file' not in arg:
                if arg not in args:
                    args.append(arg)
    
    _launch_args_cache[cache_key] = args
    return args


def _validate_launch_args(user_args, available_args):
    """Validate user-provided args against the launch file's declared args.

    All args are ALWAYS passed through unchanged — this function only adds
    informational notices about args that are not in the declared list.
    The ROS 2 launch system is the authoritative validator; we must not drop
    or rename args here.

    Returns:
        validated_args: same as user_args (passed through unmodified)
        notices: list of informational messages about unrecognised arg names
    """
    notices = []

    for arg in user_args:
        if ':=' in arg:
            arg_name = arg.split(':=', 1)[0]
        elif '=' in arg:
            arg_name = arg.split('=', 1)[0]
        else:
            arg_name = arg

        if available_args and arg_name not in available_args:
            available_str = ', '.join(sorted(available_args))
            notices.append(
                f"NOTICE: Argument '{arg_name}' is not in this launch file's declared args "
                f"(available: [{available_str}]). Passing through anyway — "
                f"the launch system will report an error if it is invalid."
            )

    return list(user_args), notices




def _find_launch_files(package):
    """Find launch files in a package."""
    prefix = get_package_prefix(package)
    if not prefix:
        return []
    
    # Common launch directories
    launch_dirs = [
        os.path.join(prefix, "share", package, "launch"),
        os.path.join(prefix, "lib", package, "launch"),
        os.path.join(prefix, "launch"),
    ]
    
    launch_files = []
    for launch_dir in launch_dirs:
        if os.path.isdir(launch_dir):
            for f in os.listdir(launch_dir):
                if f.endswith(('.launch.py', '.launch', '.xml')):
                    launch_files.append(f)
    
    return launch_files


def cmd_launch_run(args):
    """Run a ROS 2 launch file in a tmux session."""
    if not check_tmux():
        return output({
            "error": "tmux is not installed. Install with: sudo apt install tmux",
            "suggestion": "Alternatively, launch files can be run with nohup in background"
        })

    package = args.package
    launch_file = args.launch_file
    launch_args = list(args.args or [])
    params_str = getattr(args, 'params', None)
    config_path = getattr(args, 'config_path', None)
    preset_name = getattr(args, 'preset', None)
    
    # Check package exists (auto-refresh if not found)
    if not package_exists(package, force_refresh=False):
        list_packages(force_refresh=True)
    if not package_exists(package, force_refresh=False):
        return output({
            "error": f"Package '{package}' not found",
            "available_packages": list(list_packages().keys())[:20]
        })
    
    # Find launch file
    prefix = get_package_prefix(package)
    launch_files = _find_launch_files(package)
    
    # Try different possible paths
    possible_paths = [
        os.path.join(prefix, "share", package, "launch", launch_file),
        os.path.join(prefix, "lib", package, "launch", launch_file),
        launch_file,  # Relative path or full path
    ]
    
    launch_path = None
    for p in possible_paths:
        if os.path.exists(p):
            launch_path = p
            break
    
    if not launch_path and not launch_files:
        return output({
            "error": f"Launch file '{launch_file}' not found in package '{package}'",
            "searched_paths": possible_paths,
            "suggestion": "Provide full path or use 'ros2 pkg files <package>' to find launch files. "
                         "If the package is in a local workspace, set ROS2_LOCAL_WS environment variable."
        })
    
    if not launch_path and launch_files:
        return output({
            "error": f"Launch file '{launch_file}' not found",
            "available_launch_files": launch_files,
            "suggestion": "If the launch file is in a local workspace, set ROS2_LOCAL_WS environment variable."
        })
    
    # --- Build priority stack: preset < --param < positional (ROS 2 last-wins) ---
    # Final list order: [preset_args] + [param_args] + [positional_args]
    # ROS 2 uses the last occurrence of a duplicate key, so later entries win.
    extra_notices = []
    preset_args = []
    if preset_name:
        preset_args, preset_err = _load_preset(preset_name)
        if preset_err:
            extra_notices.append(f"NOTICE: {preset_err}")
            preset_args = []

    param_args = _parse_param_str(params_str) if params_str else []
    launch_args = preset_args + param_args + launch_args

    # --- Duplicate detection ---
    existing_session = _find_duplicate_launch(package, os.path.basename(launch_path))
    if existing_session:
        return output({
            "warning": (
                f"Launch '{os.path.basename(launch_path)}' from package '{package}' "
                f"appears to already be running in session '{existing_session}'."
            ),
            "existing_session": existing_session,
            "hint": (
                f"Use 'launch kill {existing_session}' to stop it first, "
                f"or 'launch restart {existing_session}' to restart with new args."
            ),
        })

    # --- Validate launch arguments against real --show-args output ---
    # Args are always passed through; validation only adds informational notices.
    arg_notices = []
    if launch_args:
        available_args = _get_launch_arguments(package, os.path.basename(launch_path))
        if not available_args:
            arg_notices.append(
                f"NOTICE: Could not retrieve declared launch arguments via --show-args. "
                f"Passing {launch_args} through without validation."
            )
        else:
            launch_args, arg_notices = _validate_launch_args(launch_args, available_args)

    # --- Config path → --ros-args --params-file per YAML file ---
    config_files = []
    if config_path:
        if os.path.isdir(config_path):
            config_files = sorted(
                os.path.join(config_path, f)
                for f in os.listdir(config_path)
                if f.endswith(('.yaml', '.yml'))
            )
        elif os.path.isfile(config_path):
            config_files = [config_path]
        else:
            extra_notices.append(
                f"NOTICE: config_path '{config_path}' is not a YAML file or directory; ignored."
            )

    # Build launch command
    cmd_parts = ["ros2 launch", package, os.path.basename(launch_path)]
    cmd_parts.extend(launch_args)
    if config_files:
        cmd_parts.append("--ros-args")
        for cf in config_files:
            cmd_parts.extend(["--params-file", shlex.quote(cf)])

    launch_cmd = " ".join(cmd_parts)
    
    # Generate session name
    session_name = generate_session_name("launch", package, launch_file.replace('.launch.py', '').replace('.launch', ''))
    
    # Get local workspace to source (auto-detected)
    ws_path, ws_status = source_local_ws()
    
    warning = None
    if ws_status == "invalid":
        return output({
            "error": "ROS2_LOCAL_WS is set but path does not exist",
            "suggestion": "Unset ROS2_LOCAL_WS or set a valid path"
        })
    elif ws_status == "not_built":
        warning = f"Warning: Local workspace found but not built. Build with 'colcon build' first."
    elif ws_status == "not_found":
        # No local workspace found - continue without sourcing
        ws_path = None
    
    # Handle existing session with same name - require explicit kill or restart
    if session_exists(session_name):
        return output({
            "error": f"Session '{session_name}' already exists",
            "suggestion": f"Use 'launch restart {session_name}' to restart, or 'launch kill {session_name}' to kill first",
            "session": session_name
        })
    
    # Build tmux command with or without sourcing
    # Use bash -c to support source command (sh doesn't support source)
    # Quote paths to handle spaces
    quoted_ws = quote_path(ws_path) if ws_path else None
    if quoted_ws:
        tmux_cmd = f"tmux new-session -d -s {session_name} 'bash -c \"source {quoted_ws} && {launch_cmd}\" 2>&1'"
    else:
        tmux_cmd = f"tmux new-session -d -s {session_name} '{launch_cmd} 2>&1'"
    
    # Run the launch command
    stdout, stderr, rc = run_cmd(tmux_cmd, timeout=30)
    
    if rc != 0:
        return output({
            "error": f"Failed to start launch file: {stderr}",
            "command": launch_cmd,
            "session": session_name
        })
    
    # Check if session is actually alive (has running process)
    is_alive = check_session_alive(session_name)
    status = "running" if is_alive else "crashed"
    
    # Get PID if available
    pid_cmd = f"tmux list-panes -t {session_name} -F '{{{{pane_pid}}}}' 2>/dev/null | head -1"
    pid_output, _, _ = run_cmd(pid_cmd)
    
    result = {
        "success": True,
        "session": session_name,
        "command": launch_cmd,
        "package": package,
        "launch_file": os.path.basename(launch_path),
        "status": status.strip() if status else "unknown",
        "launch_args": launch_args,
    }

    if config_files:
        result["config_files"] = config_files
    if preset_name:
        result["preset"] = preset_name
    if ws_path:
        result["workspace_sourced"] = ws_path

    all_notices = extra_notices + arg_notices
    if all_notices:
        result["notices"] = all_notices

    if warning:
        result["warning"] = warning

    if pid_output:
        result["pid"] = pid_output.strip()

    # Save extended metadata for restart
    save_session(session_name, {
        "type": "run",
        "package": package,
        "launch_file": os.path.basename(launch_path),
        "launch_args": launch_args,
        "params": params_str,
        "config_path": config_path,
        "preset": preset_name,
        "command": launch_cmd,
    })
    
    output(result)
    return result


def cmd_launch_list(args):
    """List running launch sessions in tmux, or search for launch files by keyword."""
    keyword = getattr(args, 'keyword', None)

    # No keyword → existing behaviour: list running tmux sessions
    if not keyword:
        result = list_sessions("launch_")
        return output(result)

    scan_all = keyword.lower() in ('all', '*')

    try:
        pkgs = list_packages()
        if not pkgs:
            return output({
                "keyword": keyword,
                "matches": [],
                "count": 0,
                "suggestion": "Could not retrieve package list — is ROS 2 sourced?",
            })

        all_pkgs = list(pkgs.keys())

        # Filter packages by keyword (unless scan_all)
        if scan_all:
            candidate_pkgs = all_pkgs
        else:
            kw_lower = keyword.lower()
            candidate_pkgs = [p for p in all_pkgs if kw_lower in p.lower()]

        matches = []
        note = "full scan — may take several seconds" if scan_all else None

        for pkg in candidate_pkgs:
            try:
                stdout, _, rc = run_cmd(f"ros2 pkg files {pkg}", timeout=30)
                if rc != 0:
                    continue
                for fpath in stdout.splitlines():
                    fpath = fpath.strip()
                    fname = os.path.basename(fpath)
                    if not (fname.endswith('.launch.py') or
                            fname.endswith('.launch.xml') or
                            fname.endswith('.launch')):
                        continue
                    kw_lower = keyword.lower() if not scan_all else ''
                    if scan_all or kw_lower in fname.lower() or kw_lower in pkg.lower():
                        matches.append({
                            "package": pkg,
                            "launch_file": fname,
                            "launch_command": f"launch new {pkg} {fname}",
                        })
            except Exception:
                continue

        result = {"keyword": keyword, "matches": matches, "count": len(matches)}
        if note:
            result["note"] = note
        if not matches:
            result["suggestion"] = (
                "Try a broader keyword or check 'ros2 pkg list' for available packages"
            )
        return output(result)

    except Exception as e:
        return output({"error": str(e)})


def cmd_launch_kill(args):
    """Kill a running launch session."""
    session = args.session
    result = kill_session_cmd(session, "launch_")
    return output(result)


def cmd_launch_restart(args):
    """Restart a launch session (kill and re-launch with same session name)."""
    if not check_tmux():
        return output({
            "error": "tmux is not installed"
        })
    
    session = args.session
    
    # Validate session name starts with launch_
    if not session.startswith('launch_'):
        return output({
            "error": f"Session '{session}' is not a launch session",
            "hint": "Launch sessions start with 'launch_'"
        })
    
    # Check if session exists
    if not session_exists(session):
        return output({
            "error": f"Session '{session}' does not exist",
            "suggestion": "Use 'launch' to start a new session",
            "available_sessions": []
        })
    
    # Load session metadata
    metadata = get_session_metadata(session)
    
    if not metadata:
        return output({
            "error": f"No metadata found for session '{session}'",
            "suggestion": "Use 'launch' to start a fresh session",
            "session": session
        })
    
    # Kill existing session
    kill_session(session)
    
    # Re-launch based on session type
    if metadata.get("type") == "foxglove":
        port = metadata.get("port", 8765)
        args_restart = type('Args', (), {
            'port': port,
            'refresh': False
        })()
        result = cmd_launch_foxglove(args_restart)
        result["message"] = "Session restarted"
        return result
    
    elif metadata.get("type") == "run":
        package = metadata.get("package")
        launch_file = metadata.get("launch_file")
        launch_args = metadata.get("launch_args", [])
        
        if not package or not launch_file:
            return output({
                "error": f"Incomplete metadata for session '{session}'",
                "suggestion": "Use 'launch' to start a fresh session"
            })
        
        args_restart = type('Args', (), {
            'package': package,
            'launch_file': launch_file,
            'args': launch_args,
            # params and preset are already expanded inside launch_args from the
            # original run — do not re-apply them or they will be doubled.
            'params': None,
            'config_path': metadata.get("config_path"),
            'preset': None,
        })()

        result = cmd_launch_run(args_restart)
        result["message"] = "Session restarted"
        return result
    
    else:
        return output({
            "error": f"Unknown session type for '{session}'",
            "suggestion": "Use 'launch' to start a fresh session"
        })


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

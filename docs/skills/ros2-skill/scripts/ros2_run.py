#!/usr/bin/env python3
"""ROS 2 run commands for running executables in tmux sessions."""

import os

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


def _find_executables(package):
    """Find executables in a package."""
    prefix = get_package_prefix(package)
    if not prefix:
        return []

    lib_dir = os.path.join(prefix, "lib", package)

    executables = []
    if os.path.isdir(lib_dir):
        for f in os.listdir(lib_dir):
            full_path = os.path.join(lib_dir, f)
            if os.path.isfile(full_path) and os.access(full_path, os.X_OK):
                executables.append(f)

    return executables


def _auto_match_executable(user_executable, available_executables):
    """Auto-match user-provided executable against available executables.
    
    Returns (matched_executable, warning).
    """
    if not user_executable or not available_executables:
        return user_executable, None
    
    # Check if exact match
    if user_executable in available_executables:
        return user_executable, None
    
    # Try fuzzy match
    matches = fuzzy_match(user_executable, available_executables)
    if matches and matches[0][1] >= 0.7:
        return matches[0][0], f"Auto-matched '{user_executable}' to '{matches[0][0]}'"
    
    return user_executable, None


def _apply_params(params_str):
    """Parse and return params from key:value or key:=value string."""
    if not params_str:
        return {}
    
    params = {}
    for pair in params_str.split(','):
        pair = pair.strip()
        # Handle both "key:value" and "key:=value" formats
        if ':=' in pair:
            key, value = pair.split(':=', 1)
        elif ':' in pair:
            key, value = pair.split(':', 1)
        else:
            continue
        # Try to parse value as number
        try:
            if '.' in value:
                params[key.strip()] = float(value)
            else:
                params[key.strip()] = int(value)
        except ValueError:
            params[key.strip()] = value.strip()
    
    return params


def cmd_run(args):
    """Run a ROS 2 executable in a tmux session."""
    if not check_tmux():
        return output({
            "error": "tmux is not installed. Install with: sudo apt install tmux"
        })
    
    package = args.package
    executable = args.executable
    run_args = args.args or []
    presets = getattr(args, 'presets', None)
    params_str = args.params
    config_path = args.config_path
    
    # Check package exists (auto-refresh if not found)
    if not package_exists(package, force_refresh=False):
        list_packages(force_refresh=True)
    if not package_exists(package, force_refresh=False):
        return output({
            "error": f"Package '{package}' not found",
            "available_packages": list(list_packages().keys())[:20]
        })
    
    # Check executable exists
    executables = _find_executables(package)
    if not executables:
        return output({
            "error": f"No executables found in package '{package}'",
            "suggestion": "Check package contents with: ros2 pkg executables " + package,
            "package": package
        })
    
    # Validate executable exists
    warning = None
    if executable not in executables:
        # Try auto-match
        matched_exe, warning = _auto_match_executable(executable, executables)
        if matched_exe != executable:
            executable = matched_exe
            # Continue with matched executable
        else:
            return output({
                "error": f"Executable '{executable}' not found in package '{package}'",
                "available_executables": executables,
                "suggestion": f"Use one of: {', '.join(executables)}"
            })
    
    # Apply presets if specified
    applied_presets = []
    if presets:
        applied_presets = [p.strip() for p in presets.split(',')]
    
    # Apply params if specified
    applied_params = _apply_params(params_str) if params_str else {}
    
    # Find config files from config_path
    config_files = []
    if config_path:
        if os.path.isdir(config_path):
            for f in os.listdir(config_path):
                if f.endswith(('.yaml', '.yml')):
                    config_files.append(os.path.join(config_path, f))
        elif os.path.isfile(config_path):
            config_files = [config_path]
    
    # Build run command
    cmd_parts = ["ros2 run", package, executable]
    cmd_parts.extend(run_args)
    
    # Add params to command if specified (key:=value format for ROS 2)
    if params_str:
        for key, value in applied_params.items():
            cmd_parts.append(f"{key}:={value}")
    
    # Add params-file arguments for config files
    for config_file in config_files:
        cmd_parts.append(f"--params-file {config_file}")
    
    run_cmd_str = " ".join(cmd_parts)
    
    # Generate session name
    session_name = generate_session_name("run", package, executable)
    
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
        ws_path = None
    
    # Handle existing session with same name - require explicit kill or restart
    if session_exists(session_name):
        return output({
            "error": f"Session '{session_name}' already exists",
            "suggestion": f"Use 'run restart {session_name}' to restart, or 'run kill {session_name}' to kill first",
            "session": session_name
        })
    
    # Build tmux command
    quoted_ws = quote_path(ws_path) if ws_path else None
    if quoted_ws:
        tmux_cmd = f"tmux new-session -d -s {session_name} 'bash -c \"source {quoted_ws} && {run_cmd_str}\" 2>&1'"
    else:
        tmux_cmd = f"tmux new-session -d -s {session_name} '{run_cmd_str} 2>&1'"
    
    stdout, stderr, rc = run_cmd(tmux_cmd, timeout=30)
    
    if rc != 0:
        return output({
            "error": f"Failed to start executable: {stderr}",
            "command": run_cmd_str,
            "session": session_name
        })
    
    # Check if session is actually alive
    is_alive = check_session_alive(session_name)
    status = "running" if is_alive else "crashed"
    
    # Get PID if available
    pid_cmd = f"tmux list-panes -t {session_name} -F '#{{pane_pid}}' 2>/dev/null | head -1"
    pid_output, _, _ = run_cmd(pid_cmd)
    
    result = {
        "success": True,
        "session": session_name,
        "command": run_cmd_str,
        "package": package,
        "executable": executable,
        "args": run_args,
        "status": status,
        "presets_applied": applied_presets,
        "params_applied": applied_params,
        "config_path": config_path,
        "config_files": config_files,
    }
    
    if ws_path:
        result["workspace_sourced"] = ws_path
    
    if warning:
        result["warning"] = warning
    
    if pid_output:
        result["pid"] = pid_output.strip()
    
    # Save session metadata for restart
    save_session(session_name, {
        "type": "run",
        "package": package,
        "executable": executable,
        "args": run_args,
        "presets": presets,
        "params": params_str,
        "config_path": config_path,
        "command": run_cmd_str
    })
    
    output(result)
    return result


def cmd_run_list(args):
    """List running run sessions in tmux."""
    result = list_sessions("run_")
    return output(result)


def cmd_run_kill(args):
    """Kill a running run session."""
    session = args.session
    result = kill_session_cmd(session, "run_")
    return output(result)


def cmd_run_restart(args):
    """Restart a run session (kill and re-launch with same session name)."""
    if not check_tmux():
        return output({
            "error": "tmux is not installed"
        })
    
    session = args.session
    
    # Validate session name starts with run_
    if not session.startswith('run_'):
        return output({
            "error": f"Session '{session}' is not a run session",
            "hint": "Run sessions start with 'run_'"
        })
    
    # Check if session exists
    if not session_exists(session):
        return output({
            "error": f"Session '{session}' does not exist",
            "suggestion": "Use 'run' to start a new session",
            "available_sessions": []
        })
    
    # Load session metadata
    metadata = get_session_metadata(session)
    
    if not metadata:
        return output({
            "error": f"No metadata found for session '{session}'",
            "suggestion": "Use 'run' to start a fresh session",
            "session": session
        })
    
    if metadata.get("type") != "run":
        return output({
            "error": f"Session '{session}' is not a run session",
            "suggestion": "Use 'launch restart' for launch sessions"
        })
    
    package = metadata.get("package")
    executable = metadata.get("executable")
    run_args = metadata.get("args", [])
    presets = metadata.get("presets")
    params_str = metadata.get("params")
    config_path = metadata.get("config_path")
    
    if not package or not executable:
        return output({
            "error": f"Incomplete metadata for session '{session}'",
            "suggestion": "Use 'run' to start a fresh session"
        })
    
    # Kill existing session
    kill_session(session)
    
    # Re-run the executable
    args_restart = type('Args', (), {
        'package': package,
        'executable': executable,
        'args': run_args,
        'presets': presets,
        'params': params_str,
        'config_path': config_path,
        'refresh': False
    })()
    
    result = cmd_run(args_restart)
    result["message"] = "Session restarted"
    return result


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

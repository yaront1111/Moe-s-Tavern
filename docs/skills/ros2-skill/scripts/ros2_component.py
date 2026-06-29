#!/usr/bin/env python3
"""ROS 2 component commands.

Implements component types by reading from the ament resource index.
No rclpy.init() or running ROS 2 graph required — reads from the filesystem.

Other subcommands (list, load, unload) rely on the composition_interfaces
service API, which is not reliably discoverable via rclpy on all RMW
implementations; they will be added when subprocess delegation is permitted.
"""

from ros2_utils import (
    output,
    ROS2CLI,
    ros2_context,
    check_tmux,
    generate_session_name,
    session_exists,
    source_local_ws,
    quote_path,
    run_cmd,
    check_session_alive,
    save_session,
    kill_session,
    delete_session_metadata,
)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_component_types(args):
    """List all registered rclcpp composable node types installed on this system.

    Reads the 'rclcpp_components' ament resource type from the ament index.
    Each package that exports composable nodes registers a resource file whose
    lines are component class names (e.g. 'my_pkg::MyNode').

    No rclpy.init() or live ROS 2 graph required.
    """
    try:
        from ament_index_python import get_resources, get_resource
    except ImportError as exc:
        output({
            "error": "ament_index_python is required: pip install ament-index-python",
            "detail": str(exc),
        })
        return

    try:
        # Returns {package_name: resource_prefix_path} for every package that
        # registers the 'rclcpp_components' resource type.
        packages = get_resources("rclcpp_components")
    except Exception as exc:
        output({"error": f"Failed to query ament index: {exc}"})
        return

    components = []
    errors = []

    for pkg_name in sorted(packages.keys()):
        try:
            content, _ = get_resource("rclcpp_components", pkg_name)
            for line in content.splitlines():
                line = line.strip()
                # Skip blank lines and comments.
                if line and not line.startswith("#"):
                    components.append({
                        "package":   pkg_name,
                        "type_name": line,
                    })
        except Exception as exc:
            # Non-fatal: log and continue so one broken package doesn't hide others.
            errors.append({"package": pkg_name, "error": str(exc)})

    result = {
        "components": components,
        "total":      len(components),
        "packages":   sorted({c["package"] for c in components}),
    }
    if errors:
        result["warnings"] = errors

    output(result)


def cmd_component_list(args):
    """List all running component containers and their loaded components.

    Discovers containers by scanning for composition_interfaces/srv/ListNodes
    services on the live graph, then calls each one.
    """
    import time as _time
    import rclpy as _rclpy

    timeout = getattr(args, 'timeout', 5.0)

    try:
        from composition_interfaces.srv import ListNodes
    except ImportError:
        output({
            "error": "composition_interfaces is not installed",
            "hint": "Install with: sudo apt install ros-$ROS_DISTRO-composition-interfaces",
        })
        return

    try:
        with ros2_context():
            node = ROS2CLI()

            # Discover all containers by finding ListNodes services
            all_services = node.get_service_names_and_types()
            containers = []
            for svc_name, svc_types in all_services:
                if "composition_interfaces/srv/ListNodes" in svc_types:
                    if svc_name.endswith("/list_nodes"):
                        containers.append(svc_name[: -len("/list_nodes")])

            if not containers:
                output({
                    "containers": [],
                    "total_containers": 0,
                    "total_components": 0,
                    "hint": "No component containers found. Start one with: ros2 run rclcpp_components component_container",
                })
                return

            results = []
            for container in sorted(containers):
                svc_name = f"{container}/list_nodes"
                client = node.create_client(ListNodes, svc_name)

                if not client.wait_for_service(timeout_sec=timeout):
                    results.append({
                        "container": container,
                        "error": f"Service {svc_name} not available within {timeout}s",
                        "components": [],
                    })
                    continue

                future = client.call_async(ListNodes.Request())
                end = _time.time() + timeout
                while _time.time() < end and not future.done():
                    _rclpy.spin_once(node, timeout_sec=0.1)

                if not future.done():
                    future.cancel()
                    results.append({
                        "container": container,
                        "error": "ListNodes call timed out",
                        "components": [],
                    })
                    continue

                resp = future.result()
                components = [
                    {"unique_id": uid, "full_node_name": name}
                    for uid, name in zip(resp.unique_ids, resp.full_node_names)
                ]
                results.append({
                    "container": container,
                    "component_count": len(components),
                    "components": components,
                })

            node.destroy_node()

        total_components = sum(
            len(r.get("components", [])) for r in results
        )
        output({
            "containers": results,
            "total_containers": len(results),
            "total_components": total_components,
        })

    except Exception as exc:
        output({"error": str(exc)})


def cmd_component_load(args):
    """Load a composable node into a running component container.

    Calls composition_interfaces/srv/LoadNode on the target container.
    Returns the assigned unique_id and full_node_name on success.
    """
    import time as _time
    import rclpy as _rclpy

    timeout = getattr(args, 'timeout', 5.0)
    container = args.container
    package_name = args.package_name
    plugin_name = args.plugin_name
    node_name = getattr(args, 'node_name', '') or ''
    node_namespace = getattr(args, 'node_namespace', '') or ''
    remap_rules = getattr(args, 'remap_rules', None) or []
    log_level = int(getattr(args, 'log_level', 0) or 0)

    try:
        from composition_interfaces.srv import LoadNode
    except ImportError:
        output({
            "error": "composition_interfaces is not installed",
            "hint": "Install with: sudo apt install ros-$ROS_DISTRO-composition-interfaces",
        })
        return

    svc_name = f"{container}/load_node"

    try:
        with ros2_context():
            node = ROS2CLI()

            client = node.create_client(LoadNode, svc_name)
            if not client.wait_for_service(timeout_sec=timeout):
                node.destroy_node()
                output({
                    "error": f"Container service not available: {svc_name}",
                    "hint": f"Is the container node '{container}' running? Check with: nodes list",
                })
                return

            request = LoadNode.Request()
            request.package_name = package_name
            request.plugin_name = plugin_name
            request.node_name = node_name
            request.node_namespace = node_namespace
            request.log_level = log_level
            request.remap_rules = list(remap_rules)

            future = client.call_async(request)
            end = _time.time() + timeout
            while _time.time() < end and not future.done():
                _rclpy.spin_once(node, timeout_sec=0.1)

            if not future.done():
                future.cancel()
                node.destroy_node()
                output({
                    "error": "LoadNode service call timed out",
                    "container": container,
                    "package_name": package_name,
                    "plugin_name": plugin_name,
                })
                return

            node.destroy_node()
            resp = future.result()
            if not resp.success:
                output({
                    "success": False,
                    "container": container,
                    "package_name": package_name,
                    "plugin_name": plugin_name,
                    "error_message": resp.error_message,
                })
                return

            output({
                "success": True,
                "container": container,
                "package_name": package_name,
                "plugin_name": plugin_name,
                "full_node_name": resp.full_node_name,
                "unique_id": resp.unique_id,
            })

    except Exception as exc:
        output({"error": str(exc)})


def cmd_component_unload(args):
    """Unload a composable node from a component container by its unique_id.

    Calls composition_interfaces/srv/UnloadNode on the target container.
    The unique_id is the integer returned by component load (or component list).
    """
    import time as _time
    import rclpy as _rclpy

    timeout = getattr(args, 'timeout', 5.0)
    container = args.container
    unique_id = args.unique_id

    try:
        from composition_interfaces.srv import UnloadNode
    except ImportError:
        output({
            "error": "composition_interfaces is not installed",
            "hint": "Install with: sudo apt install ros-$ROS_DISTRO-composition-interfaces",
        })
        return

    svc_name = f"{container}/unload_node"

    try:
        with ros2_context():
            node = ROS2CLI()

            client = node.create_client(UnloadNode, svc_name)
            if not client.wait_for_service(timeout_sec=timeout):
                node.destroy_node()
                output({
                    "error": f"Container service not available: {svc_name}",
                    "hint": f"Is the container node '{container}' running? Check with: nodes list",
                })
                return

            request = UnloadNode.Request()
            request.unique_id = unique_id

            future = client.call_async(request)
            end = _time.time() + timeout
            while _time.time() < end and not future.done():
                _rclpy.spin_once(node, timeout_sec=0.1)

            if not future.done():
                future.cancel()
                node.destroy_node()
                output({
                    "error": "UnloadNode service call timed out",
                    "container": container,
                    "unique_id": unique_id,
                })
                return

            node.destroy_node()
            resp = future.result()

            if not resp.success:
                output({
                    "success": False,
                    "container": container,
                    "unique_id": unique_id,
                    "error_message": resp.error_message,
                })
                return

            output({
                "success": True,
                "container": container,
                "unique_id": unique_id,
            })

    except Exception as exc:
        output({"error": str(exc)})


def cmd_component_kill(args):
    """Kill a standalone component container session (comp_* sessions only)."""
    from ros2_utils import kill_session_cmd
    session = args.session
    result = kill_session_cmd(session, "comp_")
    output(result)


def _cleanup_standalone_session(session_name):
    """Kill the tmux container session and remove its metadata.

    Called on every Phase 2 failure so that the session does not block a
    subsequent retry.  Phase 1 failures (tmux start itself failed or the
    session check failed) are already clean — no session exists to kill.
    """
    kill_session(session_name)
    delete_session_metadata(session_name)


def cmd_component_standalone(args):
    """Run a composable node in its own standalone container (tmux session).

    Phase 1: starts rclcpp_components/<container_type> in a tmux session,
    renaming the container node to a predictable name derived from the plugin.
    Phase 2: polls for the container's ListNodes service to appear, then
    calls LoadNode to insert the plugin.

    Returns session name, container path, and loaded component info.
    """
    import time as _time
    import rclpy as _rclpy

    package_name   = args.package_name
    plugin_name    = args.plugin_name
    container_type = getattr(args, 'container_type', 'component_container')
    container_type = "".join(c if c.isalnum() or c == '_' else '_' for c in container_type)
    node_name      = getattr(args, 'node_name', '') or ''
    node_namespace = getattr(args, 'node_namespace', '') or ''
    remap_rules    = getattr(args, 'remap_rules', None) or []
    log_level      = int(getattr(args, 'log_level', 0) or 0)
    timeout        = getattr(args, 'timeout', 10.0)

    # ── tmux check ──────────────────────────────────────────────────────────
    if not check_tmux():
        output({"error": "tmux is not installed. Install with: sudo apt install tmux"})
        return

    # ── composition_interfaces import check ─────────────────────────────────
    try:
        from composition_interfaces.srv import LoadNode, ListNodes
    except ImportError:
        output({
            "error": "composition_interfaces is not installed",
            "hint": "Install with: sudo apt install ros-$ROS_DISTRO-composition-interfaces",
        })
        return

    # ── derive container node name from plugin class name ───────────────────
    # e.g. "demo_nodes_cpp::Talker" → "talker" → "standalone_talker"
    plugin_class        = plugin_name.split("::")[-1].lower()
    safe_class          = "".join(c if c.isalnum() or c == '_' else '_' for c in plugin_class)
    container_node_name = f"standalone_{safe_class}"

    # component_container_isolated spawns two nodes: the outer managed node
    # at /{name} and the actual container at /{name}/_container.  Composition
    # services (load_node, list_nodes) live on the inner _container node.
    if container_type == "component_container_isolated":
        container_path = f"/{container_node_name}/_container"
    else:
        container_path = f"/{container_node_name}"

    # ── session name ─────────────────────────────────────────────────────────
    session_name = generate_session_name("comp", package_name, container_node_name)

    if session_exists(session_name):
        output({
            "error": f"Session '{session_name}' already exists",
            "suggestion": f"Use 'run kill {session_name}' to kill it first",
            "session": session_name,
        })
        return

    # ── workspace sourcing ───────────────────────────────────────────────────
    ws_path, ws_status = source_local_ws()
    if ws_status == "invalid":
        output({
            "error": "ROS2_LOCAL_WS is set but path does not exist",
            "suggestion": "Unset ROS2_LOCAL_WS or set a valid path",
        })
        return
    warning = None
    if ws_status == "not_built":
        warning = "Local workspace found but not built. Build with 'colcon build' first."
    elif ws_status == "not_found":
        ws_path = None

    # ── Phase 1: start container in tmux ────────────────────────────────────
    ros_cmd = (
        f"ros2 run rclcpp_components {container_type} "
        f"--ros-args -r __node:={container_node_name}"
    )
    quoted_ws = quote_path(ws_path) if ws_path else None
    if quoted_ws:
        tmux_cmd = (
            f"tmux new-session -d -s {session_name} "
            f"'bash -c \"source {quoted_ws} && {ros_cmd}\" 2>&1'"
        )
    else:
        tmux_cmd = f"tmux new-session -d -s {session_name} '{ros_cmd} 2>&1'"

    _, stderr, rc = run_cmd(tmux_cmd, timeout=15)
    if rc != 0:
        output({
            "error": f"Failed to start container: {stderr}",
            "session": session_name,
            "command": ros_cmd,
        })
        return

    if not check_session_alive(session_name):
        output({
            "error": "Container session started but immediately exited",
            "session": session_name,
            "hint": "Check package is installed: ros2 pkg list | grep rclcpp_components",
        })
        return

    # ── Phase 2: wait for container service, then load ───────────────────────
    list_svc = f"{container_path}/list_nodes"

    try:
        with ros2_context():
            node = ROS2CLI()

            # Poll for the container's list_nodes service
            deadline = _time.time() + timeout
            container_ready = False
            while _time.time() < deadline:
                names_and_types = node.get_service_names_and_types()
                if any(svc == list_svc for svc, _ in names_and_types):
                    container_ready = True
                    break
                _rclpy.spin_once(node, timeout_sec=0.2)

            if not container_ready:
                # Before hard-failing, check whether the container process
                # is actually alive but just slow (common on RPi), or whether
                # its services ended up at a different path (e.g. the caller
                # used component_container_isolated without --container-type).
                all_svcs_now = node.get_service_names_and_types()
                all_nodes    = node.get_node_names_and_namespaces()
                node.destroy_node()

                # Look for any list_nodes service that contains our node name
                alt_path = None
                for svc_name, svc_types in all_svcs_now:
                    if (svc_name.endswith("/list_nodes")
                            and container_node_name in svc_name
                            and "composition_interfaces/srv/ListNodes" in svc_types):
                        alt_path = svc_name[: -len("/list_nodes")]
                        break

                # Check whether the container node itself is alive in the graph
                container_node_alive = any(
                    container_node_name in name for name, _ns in all_nodes
                )

                # Always kill the orphaned tmux session so the next retry
                # is not blocked by a "session already exists" error.
                _cleanup_standalone_session(session_name)

                if alt_path and alt_path != container_path:
                    output({
                        "error": f"Container service not found at expected path after {timeout}s",
                        "expected_path": container_path,
                        "container_found_at": alt_path,
                        "session_killed": session_name,
                        "hint": (
                            "Container started at a different path — it may be "
                            "component_container_isolated. Re-run with "
                            "--container-type component_container_isolated."
                            if container_type != "component_container_isolated"
                            else (
                                "Container started but the component may not have loaded. "
                                "Re-run the command."
                            )
                        ),
                    })
                elif container_node_alive:
                    output({
                        "error": f"Container service not available after {timeout}s: {list_svc}",
                        "container_started": True,
                        "session_killed": session_name,
                        "hint": (
                            f"Container process was running but services were not ready within "
                            f"{timeout}s. Session killed. Re-run with a longer "
                            f"--timeout (e.g. --timeout 30)."
                        ),
                    })
                else:
                    output({
                        "error": f"Container service not available after {timeout}s: {list_svc}",
                        "container_started": False,
                        "session_killed": session_name,
                        "hint": "Container process not found — it may have crashed. Check with: run list",
                    })
                return

            # Call LoadNode
            load_svc = f"{container_path}/load_node"
            client = node.create_client(LoadNode, load_svc)
            if not client.wait_for_service(timeout_sec=3.0):
                node.destroy_node()
                _cleanup_standalone_session(session_name)
                output({
                    "error": f"LoadNode service not available: {load_svc}",
                    "session_killed": session_name,
                })
                return

            request = LoadNode.Request()
            request.package_name   = package_name
            request.plugin_name    = plugin_name
            request.node_name      = node_name
            request.node_namespace = node_namespace
            request.log_level      = log_level
            request.remap_rules    = list(remap_rules)

            future = client.call_async(request)
            end = _time.time() + timeout
            while _time.time() < end and not future.done():
                _rclpy.spin_once(node, timeout_sec=0.1)

            if not future.done():
                future.cancel()
                node.destroy_node()
                _cleanup_standalone_session(session_name)
                output({
                    "error": "LoadNode service call timed out",
                    "session_killed": session_name,
                    "container": container_path,
                })
                return

            node.destroy_node()
            resp = future.result()

            if not resp.success:
                _cleanup_standalone_session(session_name)
                output({
                    "success": False,
                    "session_killed": session_name,
                    "container": container_path,
                    "package_name": package_name,
                    "plugin_name": plugin_name,
                    "error_message": resp.error_message,
                })
                return

            result = {
                "success": True,
                "session": session_name,
                "container": container_path,
                "container_type": container_type,
                "package_name": package_name,
                "plugin_name": plugin_name,
                "full_node_name": resp.full_node_name,
                "unique_id": resp.unique_id,
                "status": "running",
            }
            if warning:
                result["warning"] = warning
            output(result)

            save_session(session_name, {
                "type": "component_standalone",
                "package_name": package_name,
                "plugin_name": plugin_name,
                "container": container_path,
                "container_type": container_type,
                "command": ros_cmd,
            })

    except Exception as exc:
        # Best-effort cleanup — if Phase 1 never ran this is a no-op.
        _cleanup_standalone_session(session_name)
        output({"error": f"Standalone launch failed: {exc}", "session_killed": session_name})


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

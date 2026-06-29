#!/usr/bin/env python3
"""ROS 2 controller manager commands."""

import os
import subprocess
import time

import rclpy

from ros2_utils import ROS2CLI, msg_to_dict, output, resolve_output_path, ros2_context


def _call_cm_service(node, srv_type, cm_name, svc_suffix, request, timeout, retries=1):
    """Call one controller manager service and return (result, error_dict).

    Creates the client, waits for the service, fires the async call, spins
    until done or timeout, then destroys the client in a finally block.
    Returns (result, None) on success or (None, {"error": "..."}) on failure.

    ``retries`` (default 1) controls how many total attempts are made before
    giving up.  Pass ``getattr(args, 'retries', 1)`` from callers.
    """
    service_name = f"{cm_name}/{svc_suffix}"
    client = node.create_client(srv_type, service_name)
    try:
        for attempt in range(retries):
            last_attempt = (attempt == retries - 1)

            if not client.wait_for_service(timeout_sec=timeout):
                if not last_attempt:
                    continue
                return None, {
                    "error": f"Controller manager service not available: {service_name}. "
                             "Is the controller manager running?"
                }

            future = client.call_async(request)
            end_time = time.time() + timeout
            while time.time() < end_time and not future.done():
                rclpy.spin_once(node, timeout_sec=0.1)

            if future.done():
                return future.result(), None

            future.cancel()
            if not last_attempt:
                continue

        return None, {"error": f"Timeout calling {service_name}"}
    finally:
        client.destroy()


def cmd_control_list_controller_types(args):
    """List available controller types and their base classes."""
    try:
        from controller_manager_msgs.srv import ListControllerTypes
        with ros2_context():
            node = ROS2CLI()
            result, err = _call_cm_service(
                node, ListControllerTypes, args.controller_manager,
                "list_controller_types", ListControllerTypes.Request(), args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        entries = [
            {"type": t, "base_class": b}
            for t, b in zip(list(result.types), list(result.base_classes))
        ]
        output({"controller_types": entries, "count": len(entries)})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_list_controllers(args):
    """List loaded controllers, their type and status."""
    try:
        from controller_manager_msgs.srv import ListControllers
        with ros2_context():
            node = ROS2CLI()
            result, err = _call_cm_service(
                node, ListControllers, args.controller_manager,
                "list_controllers", ListControllers.Request(), args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        controllers = [msg_to_dict(c) for c in result.controller]
        output({"controllers": controllers, "count": len(controllers)})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_list_hardware_components(args):
    """List available hardware components."""
    try:
        from controller_manager_msgs.srv import ListHardwareComponents
        with ros2_context():
            node = ROS2CLI()
            result, err = _call_cm_service(
                node, ListHardwareComponents, args.controller_manager,
                "list_hardware_components", ListHardwareComponents.Request(), args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        components = [msg_to_dict(c) for c in result.component]
        output({"hardware_components": components, "count": len(components)})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_list_hardware_interfaces(args):
    """List available command and state interfaces."""
    try:
        from controller_manager_msgs.srv import ListHardwareInterfaces
        with ros2_context():
            node = ROS2CLI()
            result, err = _call_cm_service(
                node, ListHardwareInterfaces, args.controller_manager,
                "list_hardware_interfaces", ListHardwareInterfaces.Request(), args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        output({
            "command_interfaces": [msg_to_dict(i) for i in result.command_interfaces],
            "state_interfaces":   [msg_to_dict(i) for i in result.state_interfaces],
        })
    except Exception as e:
        output({"error": str(e)})


def cmd_control_load_controller(args):
    """Load a controller in the controller manager."""
    try:
        from controller_manager_msgs.srv import LoadController
        with ros2_context():
            node = ROS2CLI()
            request = LoadController.Request()
            request.name = args.name
            result, err = _call_cm_service(
                node, LoadController, args.controller_manager,
                "load_controller", request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        output({"controller": args.name, "ok": result.ok})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_unload_controller(args):
    """Unload a controller from the controller manager."""
    try:
        from controller_manager_msgs.srv import UnloadController
        with ros2_context():
            node = ROS2CLI()
            request = UnloadController.Request()
            request.name = args.name
            result, err = _call_cm_service(
                node, UnloadController, args.controller_manager,
                "unload_controller", request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        output({"controller": args.name, "ok": result.ok})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_configure_controller(args):
    """Configure a loaded controller (unconfigured → inactive)."""
    try:
        from controller_manager_msgs.srv import ConfigureController
        with ros2_context():
            node = ROS2CLI()
            request = ConfigureController.Request()
            request.name = args.name
            result, err = _call_cm_service(
                node, ConfigureController, args.controller_manager,
                "configure_controller", request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        output({"controller": args.name, "ok": result.ok})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_reload_controller_libraries(args):
    """Reload controller libraries."""
    try:
        from controller_manager_msgs.srv import ReloadControllerLibraries
        with ros2_context():
            node = ROS2CLI()
            request = ReloadControllerLibraries.Request()
            request.force_kill = args.force_kill
            result, err = _call_cm_service(
                node, ReloadControllerLibraries, args.controller_manager,
                "reload_controller_libraries", request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        output({"ok": result.ok, "force_kill": args.force_kill})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_set_controller_state(args):
    """Activate or deactivate a single controller via SwitchController."""
    try:
        from controller_manager_msgs.srv import SwitchController
        from builtin_interfaces.msg import Duration
        with ros2_context():
            node = ROS2CLI()
            request = SwitchController.Request()
            if args.state == "active":
                request.activate_controllers = [args.name]
                request.deactivate_controllers = []
            else:
                request.activate_controllers = []
                request.deactivate_controllers = [args.name]
            # STRICT so a failed transition surfaces as an error rather than being silently skipped
            request.strictness = SwitchController.Request.STRICT
            request.activate_asap = False
            t = args.timeout
            request.timeout = Duration(sec=int(t), nanosec=int((t % 1) * 1_000_000_000))
            result, err = _call_cm_service(
                node, SwitchController, args.controller_manager,
                "switch_controller", request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        output({"controller": args.name, "state": args.state, "ok": result.ok})
    except Exception as e:
        output({"error": str(e)})


def cmd_control_set_hardware_component_state(args):
    """Set the lifecycle state of a hardware component."""
    try:
        from controller_manager_msgs.srv import SetHardwareComponentState
        from lifecycle_msgs.msg import State
        # Build mapping from named constants so IDs stay correct across distros
        _state_ids = {
            "unconfigured": (State.PRIMARY_STATE_UNCONFIGURED, "unconfigured"),
            "inactive":     (State.PRIMARY_STATE_INACTIVE,     "inactive"),
            "active":       (State.PRIMARY_STATE_ACTIVE,       "active"),
            "finalized":    (State.PRIMARY_STATE_FINALIZED,     "finalized"),
        }
        with ros2_context():
            node = ROS2CLI()
            state_id, state_label = _state_ids[args.state]
            request = SetHardwareComponentState.Request()
            request.name = args.name
            request.target_state = State(id=state_id, label=state_label)
            result, err = _call_cm_service(
                node, SetHardwareComponentState, args.controller_manager,
                "set_hardware_component_state", request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        out = {"component": args.name, "ok": result.ok}
        # The response field is 'state' (not 'actual_state') in all distros.
        # Guard with hasattr for safety against any future API changes.
        if hasattr(result, "state"):
            out["actual_state"] = msg_to_dict(result.state)
        output(out)
    except Exception as e:
        output({"error": str(e)})


def cmd_control_switch_controllers(args):
    """Atomically switch (activate/deactivate) multiple controllers."""
    activate   = list(args.activate or [])
    deactivate = list(args.deactivate or [])
    if not activate and not deactivate:
        return output({"error": "At least one of --activate or --deactivate must be non-empty"})
    try:
        from controller_manager_msgs.srv import SwitchController
        from builtin_interfaces.msg import Duration
        with ros2_context():
            node = ROS2CLI()
            strictness_map = {
                "BEST_EFFORT": SwitchController.Request.BEST_EFFORT,
                "STRICT":      SwitchController.Request.STRICT,
            }
            request = SwitchController.Request()
            request.activate_controllers   = activate
            request.deactivate_controllers = deactivate
            request.strictness   = strictness_map.get(args.strictness,
                                                       SwitchController.Request.BEST_EFFORT)
            request.activate_asap = args.activate_asap
            t = args.timeout
            request.timeout = Duration(sec=int(t), nanosec=int((t % 1) * 1_000_000_000))
            result, err = _call_cm_service(
                node, SwitchController, args.controller_manager,
                "switch_controller", request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        output({
            "activate":   activate,
            "deactivate": deactivate,
            "strictness": args.strictness,
            "ok":         result.ok,
        })
    except Exception as e:
        output({"error": str(e)})


def _generate_dot(controllers):
    """Render a list of controller dicts as a Graphviz DOT graph."""
    lines = ["digraph controller_diagram {", "  rankdir=LR;"]
    for ctrl in controllers:
        name  = ctrl.get("name", "unknown")
        state = ctrl.get("state", "")
        ctype = ctrl.get("type", "")
        label = f"{name}\\n{ctype}\\n({state})"
        color = "green" if state == "active" else "lightgray"
        lines.append(f'  "{name}" [label="{label}" style=filled fillcolor={color}];')
    for ctrl in controllers:
        name = ctrl.get("name", "unknown")
        for conn in ctrl.get("chain_connections", []):
            lines.append(f'  "{conn}" -> "{name}";')
    lines.append("}")
    return "\n".join(lines)


def cmd_control_view_controller_chains(args):
    """Generate a DOT diagram of loaded chained controllers, save to .artifacts/, send via Discord."""
    try:
        from controller_manager_msgs.srv import ListControllers
        with ros2_context():
            node = ROS2CLI()
            svc_result, err = _call_cm_service(
                node, ListControllers, args.controller_manager,
                "list_controllers", ListControllers.Request(), args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)

        controllers = [msg_to_dict(c) for c in svc_result.controller]
        dot_source = _generate_dot(controllers)

        # Resolve output paths; resolve_output_path creates .artifacts/ if needed.
        pdf_path = resolve_output_path(args.output)
        gv_path  = os.path.splitext(pdf_path)[0] + ".gv"

        with open(gv_path, "w") as f:
            f.write(dot_source)

        try:
            subprocess.run(
                ["dot", "-Tpdf", gv_path, "-o", pdf_path],
                check=True, capture_output=True,
            )
        except FileNotFoundError:
            return output({
                "gv_path":     gv_path,
                "pdf_path":    None,
                "warning":     "graphviz 'dot' not installed; .gv written but PDF not generated. "
                               "Install with: sudo apt install graphviz",
                "controllers": len(controllers),
            })
        except subprocess.CalledProcessError as exc:
            return output({
                "gv_path":     gv_path,
                "pdf_path":    None,
                "warning":     f"dot rendering failed: {exc.stderr.decode().strip()}",
                "controllers": len(controllers),
            })

        result_out = {
            "gv_path":     gv_path,
            "pdf_path":    pdf_path,
            "controllers": len(controllers),
        }

        if args.channel_id:
            config_path = os.path.expanduser(args.config)
            if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) == 0:
                result_out["discord_error"] = "PDF file is empty or missing; not sent to Discord"
            else:
                scripts_dir = os.path.dirname(os.path.abspath(__file__))
                discord_script = os.path.join(scripts_dir, "discord_tools.py")
                cmd = [
                    "python3", discord_script, "send-image",
                    "--path",       pdf_path,
                    "--channel-id", args.channel_id,
                    "--config",     config_path,
                ]
                try:
                    subprocess.run(cmd, check=True, capture_output=True)
                    result_out["discord_sent"] = True
                except subprocess.CalledProcessError as exc:
                    result_out["discord_error"] = exc.stderr.decode().strip()

        output(result_out)
    except Exception as e:
        output({"error": str(e)})


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

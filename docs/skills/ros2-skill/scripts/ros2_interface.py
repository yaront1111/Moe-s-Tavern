#!/usr/bin/env python3
"""ROS 2 interface commands.

Uses rosidl_runtime_py (standard ROS 2 core package, no extra install) to
read the ament resource index at filesystem level.  No rclpy.init() or
running ROS 2 graph required.
"""

from ros2_utils import output, get_msg_type, get_srv_type, get_action_type

_INTERFACE_HINT = (
    "Use formats like std_msgs/msg/String, std_srvs/srv/SetBool, "
    "nav2_msgs/action/NavigateToPose, or shorthand std_msgs/String"
)


def _resolve_interface_type(type_str):
    """Try message → service → action resolution. Returns the class or None."""
    return get_msg_type(type_str) or get_srv_type(type_str) or get_action_type(type_str)


def cmd_interface_list(args):
    """List all interface types (messages, services, actions) installed on this system."""
    try:
        from rosidl_runtime_py import (
            get_message_interfaces,
            get_service_interfaces,
            get_action_interfaces,
        )
        msgs = get_message_interfaces()
        srvs = get_service_interfaces()
        acts = get_action_interfaces()

        # Values are lists like ['msg/String', 'msg/Bool']; prepend pkg name for full path.
        messages = sorted(f"{pkg}/{name}" for pkg, names in msgs.items() for name in names)
        services = sorted(f"{pkg}/{name}" for pkg, names in srvs.items() for name in names)
        actions  = sorted(f"{pkg}/{name}" for pkg, names in acts.items() for name in names)
        total    = len(messages) + len(services) + len(actions)

        output({"messages": messages, "services": services, "actions": actions, "total": total})
    except Exception as e:
        output({"error": str(e)})


def _expand_fields(fields_dict, depth, visited=None):
    """Recursively expand message field types up to ``depth`` levels.

    At depth 0 the dict is returned unchanged (same flat behaviour as the
    default ``interface show`` output).  At depth N > 0 any field whose type
    string looks like a composite message type (contains ``/``) is resolved
    via :func:`get_msg_type` and replaced with its own expanded field dict.
    Unknown types and primitive types (no ``/``) remain as strings.
    Cycle prevention is enforced via the ``visited`` set.
    """
    if visited is None:
        visited = set()
    if not fields_dict or depth <= 0:
        return dict(fields_dict)
    result = {}
    for field_name, type_str in fields_dict.items():
        # Primitive types (no slash) or already-visited types → leave as-is
        if "/" not in type_str or type_str in visited:
            result[field_name] = type_str
            continue
        try:
            cls = get_msg_type(type_str)
            if cls is None:
                result[field_name] = type_str
                continue
            sub_fields = dict(cls.get_fields_and_field_types())
            result[field_name] = _expand_fields(
                sub_fields, depth - 1, visited | {type_str}
            )
        except Exception:
            result[field_name] = type_str
    return result


def cmd_interface_show(args):
    """Show the field structure of a message, service, or action type.

    Accepts canonical formats (pkg/msg/Name, pkg/srv/Name, pkg/action/Name)
    and shorthand (pkg/Name — tries message first, then service, then action).
    Kind is detected from class attributes, not string parsing.
    Use ``--depth N`` to recursively expand composite field types N levels deep.
    """
    try:
        type_str = args.type_str
        depth = getattr(args, "depth", 0)

        # get_msg_type handles /msg/, /srv/, /action/ prefixed strings internally.
        # For shorthand (pkg/Name) it only tries .msg; fallback to srv/action below.
        cls = _resolve_interface_type(type_str)
        if cls is None:
            output({"error": f"Unknown interface type: {type_str}", "hint": _INTERFACE_HINT})
            return

        if hasattr(cls, "Goal") and hasattr(cls, "Result") and hasattr(cls, "Feedback"):
            out = {
                "type": type_str,
                "kind": "action",
                "goal":     _expand_fields(dict(cls.Goal.get_fields_and_field_types()), depth),
                "result":   _expand_fields(dict(cls.Result.get_fields_and_field_types()), depth),
                "feedback": _expand_fields(dict(cls.Feedback.get_fields_and_field_types()), depth),
            }
        elif hasattr(cls, "Request") and hasattr(cls, "Response"):
            out = {
                "type": type_str,
                "kind": "service",
                "request":  _expand_fields(dict(cls.Request.get_fields_and_field_types()), depth),
                "response": _expand_fields(dict(cls.Response.get_fields_and_field_types()), depth),
            }
        else:
            out = {
                "type":   type_str,
                "kind":   "message",
                "fields": _expand_fields(dict(cls.get_fields_and_field_types()), depth),
            }
        if depth >= 1:
            out["depth"] = depth
        output(out)
    except Exception as e:
        output({"error": str(e)})


def cmd_interface_proto(args):
    """Show a prototype (default-value instance) of a message, service, or action type.

    Unlike 'show' (which gives field type strings), 'proto' instantiates the type
    with its default values — useful as a copy-paste template for topic publish payloads.
    Uses rosidl_runtime_py.convert.message_to_ordereddict; no rclpy.init() needed.
    """
    try:
        from rosidl_runtime_py.convert import message_to_ordereddict
        type_str = args.type_str

        cls = _resolve_interface_type(type_str)
        if cls is None:
            output({"error": f"Unknown interface type: {type_str}", "hint": _INTERFACE_HINT})
            return

        if hasattr(cls, "Goal") and hasattr(cls, "Result") and hasattr(cls, "Feedback"):
            output({
                "type": type_str,
                "kind": "action",
                "goal":     dict(message_to_ordereddict(cls.Goal())),
                "result":   dict(message_to_ordereddict(cls.Result())),
                "feedback": dict(message_to_ordereddict(cls.Feedback())),
            })
        elif hasattr(cls, "Request") and hasattr(cls, "Response"):
            output({
                "type": type_str,
                "kind": "service",
                "request":  dict(message_to_ordereddict(cls.Request())),
                "response": dict(message_to_ordereddict(cls.Response())),
            })
        else:
            output({
                "type":  type_str,
                "kind":  "message",
                "proto": dict(message_to_ordereddict(cls())),
            })
    except Exception as e:
        output({"error": str(e)})


def cmd_interface_packages(args):
    """List all packages that define at least one ROS 2 interface."""
    try:
        from rosidl_runtime_py import (
            get_message_interfaces,
            get_service_interfaces,
            get_action_interfaces,
        )
        pkgs = sorted(
            set(get_message_interfaces()) |
            set(get_service_interfaces()) |
            set(get_action_interfaces())
        )
        output({"packages": pkgs, "count": len(pkgs)})
    except Exception as e:
        output({"error": str(e)})


def cmd_interface_package(args):
    """List all interface types (messages, services, actions) for one package."""
    try:
        from rosidl_runtime_py import (
            get_message_interfaces,
            get_service_interfaces,
            get_action_interfaces,
        )
        pkg  = args.package
        msgs = get_message_interfaces()
        srvs = get_service_interfaces()
        acts = get_action_interfaces()

        messages = sorted(f"{pkg}/{n}" for n in msgs.get(pkg, []))
        services = sorted(f"{pkg}/{n}" for n in srvs.get(pkg, []))
        actions  = sorted(f"{pkg}/{n}" for n in acts.get(pkg, []))
        total    = len(messages) + len(services) + len(actions)

        if total == 0 and pkg not in (set(msgs) | set(srvs) | set(acts)):
            output({"error": f"Package '{pkg}' not found or has no interfaces"})
            return

        output({"package": pkg, "messages": messages, "services": services,
                "actions": actions, "total": total})
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

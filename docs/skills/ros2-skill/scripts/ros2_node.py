#!/usr/bin/env python3
"""ROS 2 node commands."""

from ros2_utils import ROS2CLI, output, ros2_context


def _split_node_path(full_name):
    """Split '/namespace/node_name' into (node_name, namespace)."""
    s = full_name.lstrip('/')
    if '/' in s:
        idx = s.rindex('/')
        return s[idx + 1:], '/' + s[:idx]
    return s, '/'


def cmd_nodes_list(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            node_info = node.get_node_names_and_namespaces()
        names = [f"{ns.rstrip('/')}/{n}" for n, ns in node_info]
        output({"nodes": names, "count": len(names)})
    except Exception as e:
        output({"error": str(e)})


def cmd_nodes_details(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            node_name, namespace = _split_node_path(args.node)
            publishers = node.get_publisher_names_and_types_by_node(node_name, namespace)
            subscribers = node.get_subscriber_names_and_types_by_node(node_name, namespace)
            services = node.get_service_names_and_types_by_node(node_name, namespace)
            result = {
                "node": args.node,
                "publishers": [topic for topic, _ in publishers],
                "subscribers": [topic for topic, _ in subscribers],
                "services": [svc for svc, _ in services],
            }
            try:
                result["action_servers"] = [
                    name for name, _ in
                    node.get_action_server_names_and_types_by_node(node_name, namespace)
                ]
                result["action_clients"] = [
                    name for name, _ in
                    node.get_action_client_names_and_types_by_node(node_name, namespace)
                ]
            except AttributeError:
                result["action_servers"] = []
                result["action_clients"] = []
        output(result)
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

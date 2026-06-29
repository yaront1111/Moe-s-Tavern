#!/usr/bin/env python3
"""ROS 2 lifecycle (managed node) commands."""

import time

import rclpy

from ros2_utils import ROS2CLI, output, ros2_context


def _get_managed_nodes(rclpy_node):
    """Return sorted list of managed (lifecycle) node names from the service graph."""
    service_info = rclpy_node.get_service_names_and_types()
    return sorted([
        svc[:-len('/get_state')]
        for svc, types in service_info
        if 'lifecycle_msgs/srv/GetState' in types
        and svc.endswith('/get_state')
        and len(svc) > len('/get_state')
    ])


def cmd_lifecycle_nodes(args):
    """List all managed (lifecycle) nodes by scanning for /get_state services."""
    try:
        with ros2_context():
            node = ROS2CLI()
            managed_nodes = _get_managed_nodes(node)
        output({"managed_nodes": managed_nodes, "count": len(managed_nodes)})
    except Exception as e:
        output({"error": str(e)})


def _lifecycle_query_node(rclpy_node, node_name, timeout, retries=1):
    """Query available states and transitions for one lifecycle node."""
    from lifecycle_msgs.srv import GetAvailableStates, GetAvailableTransitions

    if not node_name.startswith('/'):
        node_name = '/' + node_name

    result = {"node": node_name}

    states_client = rclpy_node.create_client(GetAvailableStates, f"{node_name}/get_available_states")
    try:
        states_result = None
        for attempt in range(retries):
            last_attempt = (attempt == retries - 1)
            if not states_client.wait_for_service(timeout_sec=timeout):
                if not last_attempt:
                    continue
                return {"node": node_name,
                        "error": f"Lifecycle service not available for {node_name}. Is it a managed node?"}
            states_future = states_client.call_async(GetAvailableStates.Request())
            end_time = time.time() + timeout
            while time.time() < end_time and not states_future.done():
                rclpy.spin_once(rclpy_node, timeout_sec=0.1)
            if states_future.done():
                states_result = states_future.result()
                break
            states_future.cancel()
            if not last_attempt:
                continue
        if states_result is None:
            return {"node": node_name, "error": "Timeout querying available states"}
        result["available_states"] = [
            {"id": s.id, "label": s.label}
            for s in states_result.available_states
        ]
    finally:
        states_client.destroy()

    trans_client = rclpy_node.create_client(GetAvailableTransitions, f"{node_name}/get_available_transitions")
    try:
        trans_result = None
        for attempt in range(retries):
            last_attempt = (attempt == retries - 1)
            if not trans_client.wait_for_service(timeout_sec=timeout):
                if not last_attempt:
                    continue
                result["available_transitions"] = []
                result["warning"] = f"get_available_transitions service not available for {node_name}"
                return result
            trans_future = trans_client.call_async(GetAvailableTransitions.Request())
            end_time = time.time() + timeout
            while time.time() < end_time and not trans_future.done():
                rclpy.spin_once(rclpy_node, timeout_sec=0.1)
            if trans_future.done():
                trans_result = trans_future.result()
                break
            trans_future.cancel()
            if not last_attempt:
                continue
        if trans_result is None:
            result["available_transitions"] = []
            result["warning"] = "Timeout querying available transitions"
            return result
        result["available_transitions"] = [
            {
                "id": td.transition.id,
                "label": td.transition.label,
                "start_state": {"id": td.start_state.id, "label": td.start_state.label},
                "goal_state": {"id": td.goal_state.id, "label": td.goal_state.label},
            }
            for td in trans_result.available_transitions
        ]
    finally:
        trans_client.destroy()

    return result


def cmd_lifecycle_list(args):
    """List available states and transitions for one or all lifecycle nodes."""
    retries = getattr(args, 'retries', 1)
    try:
        with ros2_context():
            node = ROS2CLI()
            if args.node:
                node_name = args.node if args.node.startswith('/') else '/' + args.node
                info = _lifecycle_query_node(node, node_name, args.timeout, retries)
            else:
                managed_nodes = _get_managed_nodes(node)
                info = {"nodes": [_lifecycle_query_node(node, mn, args.timeout, retries)
                                  for mn in managed_nodes]}
        output(info)
    except Exception as e:
        output({"error": str(e)})


def cmd_lifecycle_get(args):
    """Get the current lifecycle state of a managed node."""
    retries = getattr(args, 'retries', 1)
    try:
        from lifecycle_msgs.srv import GetState
        with ros2_context():
            node = ROS2CLI()
            node_name = args.node if args.node.startswith('/') else '/' + args.node
            client = node.create_client(GetState, f"{node_name}/get_state")

            for attempt in range(retries):
                last_attempt = (attempt == retries - 1)

                if not client.wait_for_service(timeout_sec=args.timeout):
                    if not last_attempt:
                        continue
                    return output({"error": f"Lifecycle service not available for {node_name}. Is it a managed node?"})

                future = client.call_async(GetState.Request())
                end_time = time.time() + args.timeout
                while time.time() < end_time and not future.done():
                    rclpy.spin_once(node, timeout_sec=0.1)

                if future.done():
                    state = future.result().current_state
                    output({"node": node_name, "state_id": state.id, "state_label": state.label})
                    return

                future.cancel()
                if not last_attempt:
                    continue

        output({"error": "Timeout getting lifecycle state"})
    except Exception as e:
        output({"error": str(e)})


def cmd_lifecycle_set(args):
    """Trigger a lifecycle state transition on a managed node."""
    retries = getattr(args, 'retries', 1)
    try:
        from lifecycle_msgs.srv import ChangeState, GetAvailableTransitions
        from lifecycle_msgs.msg import Transition
        with ros2_context():
            node = ROS2CLI()
            node_name = args.node if args.node.startswith('/') else '/' + args.node

            try:
                transition_id = int(args.transition)
            except ValueError:
                trans_client = node.create_client(
                    GetAvailableTransitions, f"{node_name}/get_available_transitions"
                )
                trans_result = None
                for attempt in range(retries):
                    last_attempt = (attempt == retries - 1)
                    if not trans_client.wait_for_service(timeout_sec=args.timeout):
                        if not last_attempt:
                            continue
                        trans_client.destroy()
                        return output({"error": f"Lifecycle service not available for {node_name}. Is it a managed node?"})
                    trans_future = trans_client.call_async(GetAvailableTransitions.Request())
                    end_time = time.time() + args.timeout
                    while time.time() < end_time and not trans_future.done():
                        rclpy.spin_once(node, timeout_sec=0.1)
                    if trans_future.done():
                        trans_result = trans_future.result()
                        break
                    trans_future.cancel()
                    if not last_attempt:
                        continue
                trans_client.destroy()
                if trans_result is None:
                    return output({"error": "Timeout querying available transitions"})
                available_transitions = trans_result.available_transitions
                # 1. Exact match  e.g. "configure", "activate", "cleanup"
                matching = [
                    td.transition.id
                    for td in available_transitions
                    if td.transition.label == args.transition
                ]
                if not matching:
                    # 2. Suffix match: input is the trailing component after '_'
                    matching = [
                        td.transition.id
                        for td in available_transitions
                        if td.transition.label.endswith('_' + args.transition)
                    ]
                if not matching:
                    # 3. Prefix match: input is the leading component before '_'
                    matching = [
                        td.transition.id
                        for td in available_transitions
                        if td.transition.label.startswith(args.transition + '_')
                    ]
                if not matching:
                    # 4. Substring match: input appears anywhere inside the label
                    matching = [
                        td.transition.id
                        for td in available_transitions
                        if args.transition in td.transition.label
                    ]
                if not matching:
                    available_labels = [td.transition.label for td in available_transitions]
                    return output({"error": f"Unknown transition '{args.transition}'. Available: {available_labels}"})
                transition_id = matching[0]

            client = node.create_client(ChangeState, f"{node_name}/change_state")

            for attempt in range(retries):
                last_attempt = (attempt == retries - 1)

                if not client.wait_for_service(timeout_sec=args.timeout):
                    if not last_attempt:
                        continue
                    return output({"error": f"Lifecycle service not available for {node_name}. Is it a managed node?"})

                request = ChangeState.Request()
                transition = Transition()
                transition.id = transition_id
                request.transition = transition

                future = client.call_async(request)
                end_time = time.time() + args.timeout
                while time.time() < end_time and not future.done():
                    rclpy.spin_once(node, timeout_sec=0.1)

                if future.done():
                    output({"node": node_name, "transition": args.transition,
                            "success": future.result().success})
                    return

                future.cancel()
                if not last_attempt:
                    continue

        output({"error": "Timeout triggering lifecycle transition"})
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

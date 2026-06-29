#!/usr/bin/env python3
"""ROS 2 action commands."""

import json
import re
import threading
import time

import rclpy

from ros2_utils import (
    ROS2CLI, get_action_type, msg_to_dict, dict_to_msg, output, ros2_context,
)
from ros2_topic import TopicSubscriber


def _get_action_type_str(node, action):
    """Return the action type string for *action* by inspecting its feedback topic."""
    for name, types in node.get_topic_names_and_types():
        if name == action + "/_action/feedback":
            for t in types:
                if '/action/' in t:
                    return re.sub(r'_FeedbackMessage$', '', t)
    return None


def cmd_actions_list(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            topics = node.get_topic_names_and_types()
        actions = []
        seen = set()
        status_topics = set()
        for name, _ in topics:
            if '/_action/' in name:
                action_name = name.split('/_action/')[0]
                if action_name not in seen:
                    seen.add(action_name)
                    actions.append(action_name)
                if name.endswith('/_action/status'):
                    status_topics.add(action_name)
        # has_active_goals: None (indeterminate) when action server is present but
        # we haven't subscribed to check; use 'actions status /name' for live state.
        has_active_goals = {a: (None if a in status_topics else False) for a in actions}
        output({"actions": actions, "count": len(actions),
                "has_active_goals": has_active_goals})
    except Exception as e:
        output({"error": str(e)})


def cmd_actions_details(args):
    if not args.action:
        return output({"error": "action argument is required"})
    try:
        with ros2_context():
            node = ROS2CLI()
            action_type_str = _get_action_type_str(node, args.action)

        result = {"action": args.action, "action_type": action_type_str or "",
                  "goal": {}, "result": {}, "feedback": {}}
        if action_type_str:
            action_class = get_action_type(action_type_str)
            if action_class:
                for attr in ("Goal", "Result", "Feedback"):
                    try:
                        result[attr.lower()] = msg_to_dict(getattr(action_class, attr)())
                    except Exception:
                        pass
        output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_actions_send(args):
    try:
        goal_data = json.loads(args.goal)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        return output({"error": f"Invalid JSON goal: {e}"})

    try:
        from rclpy.action import ActionClient
        with ros2_context():
            node = ROS2CLI()

            action_type_str = _get_action_type_str(node, args.action)
            if not action_type_str:
                return output({"error": f"Action server not found: {args.action}"})

            action_class = get_action_type(action_type_str)
            if not action_class:
                return output({"error": f"Cannot load action type: {action_type_str}"})

            client = ActionClient(node, action_class, args.action)
            timeout = args.timeout
            retries = getattr(args, 'retries', 1)
            collect_feedback = getattr(args, 'feedback', False)
            goal_id = f"goal_{int(time.time() * 1000)}"

            for attempt in range(retries):
                last_attempt = (attempt == retries - 1)

                if not client.wait_for_server(timeout_sec=timeout):
                    if not last_attempt:
                        continue
                    return output({"error": f"Action server not available: {args.action}"})

                feedback_msgs = []
                feedback_lock = threading.Lock()

                def _feedback_cb(fb_msg):
                    if collect_feedback:
                        with feedback_lock:
                            feedback_msgs.append(msg_to_dict(fb_msg.feedback))

                goal_msg = dict_to_msg(action_class.Goal, goal_data)
                future = client.send_goal_async(
                    goal_msg,
                    feedback_callback=_feedback_cb if collect_feedback else None,
                )

                end_time = time.time() + timeout
                while time.time() < end_time and not future.done():
                    rclpy.spin_once(node, timeout_sec=0.1)

                if not future.done():
                    future.cancel()
                    if not last_attempt:
                        continue
                    output({"action": args.action, "success": False,
                            "error": "Timeout waiting for goal acceptance"})
                    return

                goal_handle = future.result()
                if not goal_handle.accepted:
                    if not last_attempt:
                        continue
                    output({"action": args.action, "success": False, "error": "Goal rejected"})
                    return

                result_future = goal_handle.get_result_async()

                end_time = time.time() + timeout
                while time.time() < end_time and not result_future.done():
                    rclpy.spin_once(node, timeout_sec=0.1)

                if result_future.done():
                    result_dict = msg_to_dict(result_future.result().result)
                    out = {"action": args.action, "success": True,
                           "goal_id": goal_id, "result": result_dict}
                    if collect_feedback:
                        with feedback_lock:
                            out["feedback_msgs"] = list(feedback_msgs)
                    output(out)
                    return

                result_future.cancel()
                if not last_attempt:
                    continue

        output({"action": args.action, "success": False,
                "error": f"Timeout after {timeout}s"})
    except Exception as e:
        output({"error": str(e)})


def cmd_actions_type(args):
    """Get the type of an action server."""
    if not args.action:
        return output({"error": "action argument is required"})

    action = args.action.rstrip('/')
    try:
        with ros2_context():
            node = ROS2CLI()
            action_type_str = _get_action_type_str(node, action)

        if action_type_str is None:
            return output({"error": f"Action '{action}' not found in the ROS graph"})
        output({"action": action, "type": action_type_str})
    except Exception as e:
        output({"error": str(e)})


def _parse_goal_id_uuid(goal_id_str: str):
    """Convert a UUID string to a 16-byte list for CancelGoal.Request.

    Accepts dash-separated UUID (e.g. '550e8400-e29b-41d4-a716-446655440000')
    or plain 32-hex string.  Returns list of 16 ints or raises ValueError.
    """
    import uuid as _uuid
    try:
        parsed = _uuid.UUID(goal_id_str)
        return list(parsed.bytes)
    except ValueError:
        raise ValueError(f"Invalid goal UUID '{goal_id_str}' — expected standard UUID format")


def cmd_actions_cancel(args):
    """Cancel in-flight goals on an action server.

    Without --goal-id: cancels ALL goals (uuid = all-zeros sentinel).
    With --goal-id UUID: cancels only the goal with that UUID.
    """
    if not args.action:
        return output({"error": "action argument is required"})

    action = args.action.rstrip('/')
    timeout = args.timeout
    retries = getattr(args, 'retries', 1)
    goal_id_str = getattr(args, 'goal_id', None)

    # Parse goal UUID if provided
    goal_uuid = [0] * 16   # all-zeros = cancel ALL
    if goal_id_str:
        try:
            goal_uuid = _parse_goal_id_uuid(goal_id_str)
        except ValueError as e:
            return output({"error": str(e)})

    try:
        from action_msgs.srv import CancelGoal
        from builtin_interfaces.msg import Time as BuiltinTime
        with ros2_context():
            node = ROS2CLI()
            client = node.create_client(CancelGoal, action + '/_action/cancel_goal')

            for attempt in range(retries):
                last_attempt = (attempt == retries - 1)

                if not client.wait_for_service(timeout_sec=timeout):
                    if not last_attempt:
                        continue
                    return output({"error": f"Action server '{action}' not available"})

                request = CancelGoal.Request()
                request.goal_info.goal_id.uuid = goal_uuid
                request.goal_info.stamp = BuiltinTime(sec=0, nanosec=0)

                future = client.call_async(request)
                end_time = time.time() + timeout
                while time.time() < end_time and not future.done():
                    rclpy.spin_once(node, timeout_sec=0.1)

                if future.done():
                    result = future.result()
                    cancelled = [str(bytes(g.goal_id.uuid)) for g in (result.goals_canceling or [])]
                    out = {
                        "action": action,
                        "return_code": result.return_code,
                        "cancelled_goals": len(cancelled),
                    }
                    if goal_id_str:
                        out["goal_id"] = goal_id_str
                    output(out)
                    return

                future.cancel()
                if not last_attempt:
                    continue

        output({"error": f"Timeout cancelling goals on '{action}'"})
    except Exception as e:
        output({"error": str(e)})


def cmd_actions_echo(args):
    """Echo action feedback and status messages from a live action server."""
    if not args.action:
        return output({"error": "action argument is required"})

    action = args.action.rstrip('/')
    feedback_topic = action + '/_action/feedback'
    status_topic = action + '/_action/status'

    try:
        with ros2_context():
            node = ROS2CLI()
            all_topics = dict(node.get_topic_names_and_types())
            node.destroy_node()

            if feedback_topic not in all_topics:
                return output({"error": f"Action server not found: {action}"})

            feedback_type = all_topics[feedback_topic][0]
            status_type = (all_topics[status_topic][0]
                           if status_topic in all_topics else None)

            action_base_type = re.sub(r'_FeedbackMessage$', '', feedback_type)
            action_class = get_action_type(action_base_type)
            if action_class is None:
                return output({"error": f"Could not load action type: {action_base_type}"})
            fb_msg_class = action_class.Impl.FeedbackMessage

            fb_sub = TopicSubscriber(feedback_topic, feedback_type, msg_class=fb_msg_class)
            if fb_sub.sub is None:
                return output({"error": f"Could not load feedback message type: {feedback_type}"})

            executor = rclpy.executors.SingleThreadedExecutor()
            executor.add_node(fb_sub)

            status_sub = None
            if status_type:
                status_sub = TopicSubscriber(status_topic, status_type)
                executor.add_node(status_sub)

            if args.duration:
                end_time = time.time() + args.duration
                while time.time() < end_time and len(fb_sub.messages) < (args.max_messages or 100):
                    executor.spin_once(timeout_sec=0.1)
                with fb_sub.lock:
                    feedback_msgs = (fb_sub.messages[:args.max_messages]
                                     if args.max_messages else fb_sub.messages[:])
                status_msgs = []
                if status_sub:
                    with status_sub.lock:
                        status_msgs = status_sub.messages[:]
                output({
                    "action": action,
                    "collected_count": len(feedback_msgs),
                    "feedback": feedback_msgs,
                    "status": status_msgs,
                })
            else:
                end_time = time.time() + args.timeout
                while time.time() < end_time:
                    executor.spin_once(timeout_sec=0.1)
                    with fb_sub.lock:
                        if fb_sub.messages:
                            output({"action": action, "feedback": fb_sub.messages[0]})
                            return
                output({"error": "Timeout waiting for action feedback"})
    except Exception as e:
        output({"error": str(e)})


def cmd_actions_find(args):
    """Find action servers of a specific action type."""
    if not args.action_type:
        return output({"error": "action_type argument is required"})

    target_raw = args.action_type

    def _norm_action(t):
        return re.sub(r'/action/', '/', t)

    target_norm = _norm_action(target_raw)

    try:
        with ros2_context():
            node = ROS2CLI()
            all_topics = node.get_topic_names_and_types()

        matched = []
        seen = set()
        for name, types in all_topics:
            if '/_action/feedback' in name:
                action_name = name.split('/_action/')[0]
                if action_name in seen:
                    continue
                for t in types:
                    resolved = re.sub(r'_FeedbackMessage$', '', t)
                    if _norm_action(resolved) == target_norm:
                        matched.append(action_name)
                        seen.add(action_name)
                        break

        output({
            "action_type": target_raw,
            "actions": matched,
            "count": len(matched),
        })
    except Exception as e:
        output({"error": str(e)})


_STATUS_NAMES = {
    0: "UNKNOWN", 1: "ACCEPTED", 2: "EXECUTING", 3: "CANCELING",
    4: "SUCCEEDED", 5: "CANCELED", 6: "ABORTED",
}


def cmd_actions_status(args):
    """One-shot poll of active goal IDs and status codes for an action server.

    Subscribes to /<action>/_action/status for up to --timeout seconds,
    captures the first status message, and returns the goal list with
    human-readable status names.  Returns {action, goal_statuses, active_count}
    or {error} if the action server is not found or times out.
    """
    if not args.action:
        return output({"error": "action argument is required"})

    action = args.action.rstrip('/')
    status_topic = action + '/_action/status'
    timeout = args.timeout

    try:
        from action_msgs.msg import GoalStatusArray

        with ros2_context():
            node = ROS2CLI()

            # Verify the action server exists by checking topic presence
            all_topics = dict(node.get_topic_names_and_types())
            if status_topic not in all_topics:
                return output({
                    "error": f"Action server not found: {action}",
                    "hint": "Is the action server running? Use 'actions list' to see active servers.",
                })

            received = []
            done_event = threading.Event()

            sub = node.create_subscription(
                GoalStatusArray,
                status_topic,
                lambda msg: (received.append(msg), done_event.set()),
                10,
            )

            end = time.time() + timeout
            while time.time() < end and not done_event.is_set():
                rclpy.spin_once(node, timeout_sec=0.1)

        if not received:
            # No status message within timeout — server present but no goals published yet
            return output({
                "action": action,
                "goal_statuses": [],
                "active_count": 0,
                "note": f"No status message received within {timeout}s — "
                        "server is present but may have no active goals.",
            })

        msg = received[0]
        goal_statuses = []
        active_count = 0
        for gs in msg.status_list:
            uuid_bytes = bytes(gs.goal_info.goal_id.uuid)
            import uuid as _uuid
            goal_id_str = str(_uuid.UUID(bytes=uuid_bytes))
            status_int = int(gs.status)
            is_active = status_int in (1, 2, 3)  # ACCEPTED, EXECUTING, CANCELING
            if is_active:
                active_count += 1
            goal_statuses.append({
                "goal_id": goal_id_str,
                "status": status_int,
                "status_name": _STATUS_NAMES.get(status_int, f"STATUS_{status_int}"),
                "active": is_active,
            })

        output({
            "action": action,
            "goal_statuses": goal_statuses,
            "active_count": active_count,
        })

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

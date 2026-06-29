#!/usr/bin/env python3
"""ROS 2 service commands."""

import json
import re
import time

import rclpy

from ros2_utils import (
    ROS2CLI, get_srv_type, msg_to_dict, dict_to_msg, output,
    ros2_context, _get_service_event_qos,
    is_at_least, get_ros_distro,
)
from ros2_topic import TopicSubscriber


def cmd_services_list(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            services = node.get_service_names()
            service_list = []
            type_list = []
            for name, types in services:
                service_list.append(name)
                type_list.append(types[0] if types else "")
        output({"services": service_list, "types": type_list, "count": len(service_list)})
    except Exception as e:
        output({"error": str(e)})


def cmd_services_type(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            services = node.get_service_names()
            svc_type = ""
            for name, types in services:
                if name == args.service:
                    svc_type = types[0] if types else ""
                    break
        output({"service": args.service, "type": svc_type})
    except Exception as e:
        output({"error": str(e)})


def cmd_services_details(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            services = node.get_service_names()
            result = {"service": args.service, "type": "", "request": {}, "response": {}}
            for name, types in services:
                if name == args.service:
                    result["type"] = types[0] if types else ""
                    break
            if result["type"]:
                srv_class = get_srv_type(result["type"])
                if srv_class:
                    try:
                        result["request"] = msg_to_dict(srv_class.Request())
                    except Exception:
                        pass
                    try:
                        result["response"] = msg_to_dict(srv_class.Response())
                    except Exception:
                        pass
        output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_services_info(args):
    """Alias for details; on Lyrical Luth adds QoS/endpoint data with --verbose.

    Without ``--verbose`` (or on pre-Lyrical distros) the output is identical
    to ``services details``.  With ``--verbose`` on Lyrical or newer, two extra
    keys are added::

        "servers": [{"node_name": ..., "node_namespace": ..., "qos": {...}}, ...]
        "clients": [{"node_name": ..., "node_namespace": ...}, ...]
    """
    verbose = getattr(args, 'verbose', False)

    try:
        with ros2_context():
            node = ROS2CLI()
            services = node.get_service_names()
            result = {"service": args.service, "type": "", "request": {}, "response": {}}
            for name, types in services:
                if name == args.service:
                    result["type"] = types[0] if types else ""
                    break

            if result["type"]:
                srv_class = get_srv_type(result["type"])
                if srv_class:
                    try:
                        result["request"] = msg_to_dict(srv_class.Request())
                    except Exception:
                        pass
                    try:
                        result["response"] = msg_to_dict(srv_class.Response())
                    except Exception:
                        pass

            if verbose:
                if is_at_least("lyrical"):
                    try:
                        servers = node.get_servers_info_by_service(args.service)
                        result["servers"] = [
                            {
                                "node_name": s.node_name,
                                "node_namespace": s.node_namespace,
                                "qos": {
                                    "reliability": str(s.qos_profile.reliability),
                                    "durability": str(s.qos_profile.durability),
                                    "history": str(s.qos_profile.history),
                                    "depth": s.qos_profile.depth,
                                },
                            }
                            for s in (servers or [])
                        ]
                        clients = node.get_clients_info_by_service(args.service)
                        result["clients"] = [
                            {
                                "node_name": c.node_name,
                                "node_namespace": c.node_namespace,
                            }
                            for c in (clients or [])
                        ]
                    except AttributeError:
                        # API exists on Lyrical but method name may vary
                        result["verbose_note"] = (
                            "QoS/endpoint info unavailable — "
                            "get_servers_info_by_service() not found on this rclpy build"
                        )
                else:
                    result["verbose_note"] = (
                        f"--verbose requires Lyrical Luth or newer "
                        f"(active distro: {get_ros_distro()})"
                    )

        output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_services_call(args):
    if getattr(args, 'extra_request', None) is not None:
        service_type_override = args.request
        request_json = args.extra_request
    else:
        service_type_override = None
        request_json = args.request

    try:
        request_data = json.loads(request_json)
    except (json.JSONDecodeError, TypeError) as e:
        return output({"error": f"Invalid JSON request: {e}"})

    retries = getattr(args, 'retries', 1)

    try:
        with ros2_context():
            node = ROS2CLI()

            service_type = service_type_override or args.service_type
            if not service_type:
                for name, types in node.get_service_names():
                    if name == args.service:
                        service_type = types[0] if types else ""
                        break

            if not service_type:
                return output({
                    "error": f"Service not found: {args.service}",
                    "hint": "Use --service-type to specify the type explicitly (e.g. --service-type std_srvs/srv/SetBool)"
                })

            srv_class = get_srv_type(service_type)
            if not srv_class:
                return output({"error": f"Cannot load service type: {service_type}"})

            client = node.create_client(srv_class, args.service)
            timeout = args.timeout

            for attempt in range(retries):
                last_attempt = (attempt == retries - 1)

                if not client.wait_for_service(timeout_sec=timeout):
                    if not last_attempt:
                        continue
                    return output({"error": f"Service not available: {args.service}"})

                request = dict_to_msg(srv_class.Request, request_data)
                future = client.call_async(request)

                end_time = time.time() + timeout
                while time.time() < end_time and not future.done():
                    rclpy.spin_once(node, timeout_sec=0.1)

                if future.done():
                    result_dict = msg_to_dict(future.result())
                    output({"service": args.service, "success": True, "result": result_dict})
                    return

                future.cancel()
                if not last_attempt:
                    continue

        output({"service": args.service, "success": False, "error": "Service call timeout"})
    except Exception as e:
        output({"error": str(e)})


def cmd_services_echo(args):
    """Echo service request/response events via service introspection."""
    if not args.service:
        return output({"error": "service argument is required"})

    service = args.service.rstrip('/')
    event_topic = service + '/_service_event'

    try:
        with ros2_context():
            node = ROS2CLI()
            all_topics = dict(node.get_topic_names_and_types())
            node.destroy_node()

            if event_topic not in all_topics:
                return output({
                    "error": f"No service event topic found: {event_topic}",
                    "hint": (
                        "Service introspection must be enabled on the server/client "
                        "via configure_introspection(clock, qos, "
                        "ServiceIntrospectionState.METADATA or CONTENTS)."
                    ),
                })

            msg_type = all_topics[event_topic][0]
            subscriber = TopicSubscriber(event_topic, msg_type,
                                         qos=_get_service_event_qos())

            if subscriber.sub is None:
                return output({"error": f"Could not load event message type: {msg_type}"})

            executor = rclpy.executors.SingleThreadedExecutor()
            executor.add_node(subscriber)

            window = args.duration if args.duration is not None else args.timeout
            max_events = args.max_messages
            end_time = time.time() + window

            try:
                while time.time() < end_time:
                    if max_events is not None and len(subscriber.messages) >= max_events:
                        break
                    executor.spin_once(timeout_sec=0.1)
            except KeyboardInterrupt:
                pass

            with subscriber.lock:
                events = (subscriber.messages[:max_events]
                          if max_events is not None else subscriber.messages[:])

        output({
            "service": service,
            "event_topic": event_topic,
            "collected_count": len(events),
            "events": events,
        })
    except Exception as e:
        output({"error": str(e)})


def cmd_services_find(args):
    """Find services of a specific service type."""
    if not args.service_type:
        return output({"error": "service_type argument is required"})

    # Path A guard: refuse live discovery when the profile has this field.
    if not getattr(args, "ignore_profile", False):
        try:
            from ros2_profile import (
                load_profile_summary, check_services_find_path_a,
            )
            summary = load_profile_summary()
            if summary:
                violation = check_services_find_path_a(args.service_type, summary)
                if violation:
                    return output(violation)
        except Exception:
            pass

    target_raw = args.service_type

    def _norm_srv(t):
        return re.sub(r'/srv/', '/', t)

    target_norm = _norm_srv(target_raw)

    try:
        with ros2_context():
            node = ROS2CLI()
            all_services = node.get_service_names_and_types()

        matched = [
            name for name, types in all_services
            if any(_norm_srv(t) == target_norm for t in types)
        ]
        output({
            "service_type": target_raw,
            "services": matched,
            "count": len(matched),
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

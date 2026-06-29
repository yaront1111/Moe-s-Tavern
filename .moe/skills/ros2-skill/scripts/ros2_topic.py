#!/usr/bin/env python3
"""ROS 2 topic commands and emergency stop."""

import copy
import json
import math
import os
import re
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_system_default, qos_profile_sensor_data, ReliabilityPolicy

from ros2_utils import (
    ROS2CLI, get_msg_type, get_msg_error, get_msg_fields,
    msg_to_dict, dict_to_msg, output, resolve_field, _get_service_event_qos,
    resolve_output_path, ros2_context, resolve_topic_type,
)

# ---------------------------------------------------------------------------
# Velocity message types used to identify velocity command topics.
VELOCITY_TYPES = {
    f"geometry_msgs{q}{t}"
    for q in ("/msg/", "/")
    for t in ("Twist", "TwistStamped")
}

# Diagnostic message types (with and without /msg/ qualifier).
DIAG_TYPES = {f"diagnostic_msgs{q}DiagnosticArray" for q in ("/msg/", "/")}

# Numeric level → human-readable name (mirrors DiagnosticStatus constants).
_DIAG_LEVEL_NAMES = {0: "OK", 1: "WARN", 2: "ERROR", 3: "STALE"}

# Battery message types (with and without /msg/ qualifier).
BATTERY_TYPES = {f"sensor_msgs{q}BatteryState" for q in ("/msg/", "/")}

# Numeric code → human-readable name (mirrors BatteryState constants).
_BATTERY_POWER_SUPPLY_STATUS = {
    0: "UNKNOWN", 1: "CHARGING", 2: "DISCHARGING", 3: "NOT_CHARGING", 4: "FULL",
}
_BATTERY_POWER_SUPPLY_HEALTH = {
    0: "UNKNOWN", 1: "GOOD", 2: "OVERHEAT", 3: "DEAD", 4: "OVERVOLTAGE",
    5: "UNSPEC_FAILURE", 6: "COLD", 7: "WATCHDOG_TIMER_EXPIRE", 8: "SAFETY_TIMER_EXPIRE",
}
_BATTERY_POWER_SUPPLY_TECHNOLOGY = {
    0: "UNKNOWN", 1: "NIMH", 2: "LION", 3: "LIPO", 4: "LIFE", 5: "NICD", 6: "LIMN",
}


# ---------------------------------------------------------------------------
# estop
# ---------------------------------------------------------------------------

def cmd_estop(args):
    """Emergency stop for mobile robots - auto-detect and publish zero velocity."""

    def find_velocity_topic(node):
        topics = node.get_topic_names()
        candidates = [
            (name, next(t for t in types if t in VELOCITY_TYPES))
            for name, types in topics
            if any(t in VELOCITY_TYPES for t in types)
        ]
        if not candidates:
            return None, None
        preferred = [(name, t) for name, t in candidates if "cmd_vel" in name.lower()]
        return preferred[0] if preferred else candidates[0]

    try:
        with ros2_context():
            node = ROS2CLI("estop")

            if args.topic:
                topic = args.topic
                msg_type = None
                for name, types in node.get_topic_names():
                    if name == topic and types:
                        msg_type = types[0]
                        break
                if not msg_type:
                    return output({
                        "error": f"Could not detect message type for topic '{topic}'",
                        "hint": "Ensure the topic is active and visible in the ROS graph. Use 'topics type <topic>' to inspect it."
                    })
            else:
                topic, msg_type = find_velocity_topic(node)

            if not topic:
                return output({
                    "error": "Could not find velocity command topic",
                    "hint": "This command is for mobile robots only (not arms). Ensure the robot has a /cmd_vel topic."
                })

            msg_class = get_msg_type(msg_type)
            if not msg_class:
                if args.topic:
                    return output({
                        "error": f"Could not load message type '{msg_type}' for topic '{topic}'",
                        "hint": "Ensure the ROS workspace is built and sourced: cd ~/ros2_ws && colcon build && source install/setup.bash"
                    })
                else:
                    for t in VELOCITY_TYPES:
                        msg_class = get_msg_type(t)
                        if msg_class:
                            msg_type = t
                            break

            if not msg_class:
                return output({"error": f"Could not load message type: {msg_type}"})

            pub = node.create_publisher(msg_class, topic, 10)
            msg = msg_class()

            if hasattr(msg, "twist"):
                msg.header.stamp = node.get_clock().now().to_msg()
                msg.twist.linear.x = 0.0
                msg.twist.linear.y = 0.0
                msg.twist.linear.z = 0.0
                msg.twist.angular.x = 0.0
                msg.twist.angular.y = 0.0
                msg.twist.angular.z = 0.0
            else:
                msg.linear.x = 0.0
                msg.linear.y = 0.0
                msg.linear.z = 0.0
                msg.angular.x = 0.0
                msg.angular.y = 0.0
                msg.angular.z = 0.0

            # Publish in a burst to ensure delivery regardless of QoS/late discovery
            burst_count = 10
            burst_interval = 0.05  # 20 Hz over 0.5 s
            for _ in range(burst_count):
                pub.publish(msg)
                time.sleep(burst_interval)

        output({
            "success": True,
            "topic": topic,
            "type": msg_type,
            "message": "Emergency stop activated (mobile robot stopped)"
        })
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# topics list / type / details / message
# ---------------------------------------------------------------------------

def cmd_topics_list(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            topics = node.get_topic_names()
            topic_list = []
            type_list = []
            for name, types in topics:
                topic_list.append(name)
                type_list.append(types[0] if types else "")
        limit = getattr(args, "limit", 0) or 0
        total = len(topic_list)
        if limit > 0 and total > limit:
            topic_list = topic_list[:limit]
            type_list = type_list[:limit]
            result = {"topics": topic_list, "types": type_list, "count": limit,
                      "total": total, "truncated": True}
        else:
            result = {"topics": topic_list, "types": type_list, "count": total}
        output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_type(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            topics = node.get_topic_names()
            result = {"topic": args.topic, "type": ""}
            for name, types in topics:
                if name == args.topic:
                    result["type"] = types[0] if types else ""
                    break
        output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_details(args):
    try:
        with ros2_context():
            node = ROS2CLI()
            topic_types = node.get_topic_names_and_types()
            result = {"topic": args.topic, "type": "", "publishers": [], "subscribers": []}

            for name, types in topic_types:
                if name == args.topic:
                    result["type"] = types[0] if types else ""
                    break

            try:
                pub_info = node.get_publishers_info_by_topic(args.topic)
                result["publishers"] = [
                    f"{i.node_namespace.rstrip('/')}/{i.node_name}" for i in pub_info
                ]
            except Exception:
                pass

            try:
                sub_info = node.get_subscriptions_info_by_topic(args.topic)
                result["subscribers"] = [
                    f"{i.node_namespace.rstrip('/')}/{i.node_name}" for i in sub_info
                ]
            except Exception:
                pass

        output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_message(args):
    try:
        fields = get_msg_fields(args.message_type)
        output({"message_type": args.message_type, "structure": fields})
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _node_name(prefix, topic):
    """Build a unique-per-topic ROS 2 node name: skill_<prefix>_<topic_slug>."""
    slug = re.sub(r'[^a-zA-Z0-9]', '_', topic.lstrip('/')).strip('_') or 'topic'
    return f"skill_{prefix}_{slug}"


# ---------------------------------------------------------------------------
# Subscriber node
# ---------------------------------------------------------------------------

def _count_msg_bytes(d):
    """Return the byte size of a message dict as serialised JSON."""
    import json
    return len(json.dumps(d))


class TopicSubscriber(Node):
    def __init__(self, topic, msg_type, msg_class=None, qos=None,
                 throttle_rate_ms=None, max_bytes=None):
        super().__init__(_node_name('sub', topic))
        self.msg_type = msg_type
        self.messages = []
        self.lock = threading.Lock()
        self.sub = None
        self._throttle_rate_ms = throttle_rate_ms
        self._last_received_ms = None   # wall-clock ms of last kept message
        self._max_bytes = max_bytes
        self._bytes_seen = 0

        resolved_class = msg_class if msg_class is not None else get_msg_type(msg_type)
        resolved_qos = qos if qos is not None else qos_profile_system_default
        if resolved_class:
            self.sub = self.create_subscription(
                resolved_class, topic, self.callback, resolved_qos
            )

    def callback(self, msg):
        now_ms = time.time() * 1000.0
        with self.lock:
            if self._throttle_rate_ms is not None and self._last_received_ms is not None:
                elapsed = now_ms - self._last_received_ms
                if elapsed < self._throttle_rate_ms:
                    return          # drop — within throttle window
            self._last_received_ms = now_ms
            self.messages.append(msg_to_dict(msg))
            self._bytes_seen += _count_msg_bytes(self.messages[-1])


def cmd_topics_subscribe(args):
    if not args.topic:
        return output({"error": "topic argument is required"})

    throttle_rate_ms = getattr(args, "throttle_rate_ms", None)
    max_bytes = getattr(args, "max_bytes", None)

    try:
        with ros2_context():
            temp = ROS2CLI("temp")
            msg_type = resolve_topic_type(temp, args.topic, args.msg_type)
            temp.destroy_node()

            if not msg_type:
                return output({"error": f"Could not detect message type for topic: {args.topic}"})

            subscriber = TopicSubscriber(args.topic, msg_type,
                                         throttle_rate_ms=throttle_rate_ms,
                                         max_bytes=max_bytes)

            if subscriber.sub is None:
                return output({"error": f"Could not load message type: {msg_type}"})

            executor = rclpy.executors.SingleThreadedExecutor()
            executor.add_node(subscriber)

            if args.duration:
                cap = args.max_messages or 100
                end_time = time.time() + args.duration
                while (time.time() < end_time
                       and len(subscriber.messages) < cap
                       and (max_bytes is None or subscriber._bytes_seen < max_bytes)):
                    executor.spin_once(timeout_sec=0.1)

                with subscriber.lock:
                    all_received = len(subscriber.messages)
                    messages = subscriber.messages[:cap]
                    bytes_collected = subscriber._bytes_seen

                capped = all_received >= cap
                capped_bytes = max_bytes is not None and bytes_collected >= max_bytes
                messages_dropped = max(0, all_received - len(messages))
                out = {
                    "topic": args.topic,
                    "collected_count": len(messages),
                    "capped": capped,
                    "messages_dropped": messages_dropped,
                    "bytes_collected": bytes_collected,
                    "capped_bytes": capped_bytes,
                    "messages": messages,
                }
                if throttle_rate_ms is not None:
                    out["throttle_rate_ms"] = throttle_rate_ms
                output(out)
            else:
                timeout_sec = args.timeout
                end_time = time.time() + timeout_sec

                while time.time() < end_time:
                    executor.spin_once(timeout_sec=0.1)
                    with subscriber.lock:
                        if subscriber.messages:
                            output({"msg": subscriber.messages[0]})
                            return

                output({"error": "Timeout waiting for message"})
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_echo_once(args):
    """Subscribe to a topic and return the first message received, then exit.

    Unlike `subscribe`, this command exits immediately after the first message
    instead of continuing to collect. Useful for quick one-shot introspection
    without having to specify --max-messages or short durations.
    """
    if not args.topic:
        return output({"error": "topic argument is required"})

    try:
        with ros2_context():
            temp = ROS2CLI("temp")
            msg_type = resolve_topic_type(temp, args.topic, getattr(args, 'msg_type', None))
            temp.destroy_node()

            if not msg_type:
                return output({"error": f"Could not detect message type for topic: {args.topic}"})

            subscriber = TopicSubscriber(args.topic, msg_type)
            if subscriber.sub is None:
                return output({"error": f"Could not load message type: {msg_type}"})

            executor = rclpy.executors.SingleThreadedExecutor()
            executor.add_node(subscriber)

            timeout_sec = getattr(args, 'timeout', 5.0)
            end_time = time.time() + timeout_sec

            while time.time() < end_time:
                executor.spin_once(timeout_sec=0.1)
                with subscriber.lock:
                    if subscriber.messages:
                        output({"topic": args.topic, "type": msg_type, "msg": subscriber.messages[0]})
                        return

            output({"error": f"Timeout after {timeout_sec}s — no message received on {args.topic}"})
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# Publisher node
# ---------------------------------------------------------------------------

class TopicPublisher(Node):
    def __init__(self, topic, msg_type):
        super().__init__(_node_name('pub', topic))
        self.topic = topic
        self.msg_type = msg_type
        self.pub = None

        msg_class = get_msg_type(msg_type)
        if msg_class:
            self.pub = self.create_publisher(msg_class, topic, qos_profile_system_default)


# ---------------------------------------------------------------------------
# Condition monitor node (for publish-until)
# ---------------------------------------------------------------------------

def quaternion_to_yaw(q):
    """Extract yaw (rotation around z-axis) from quaternion (x, y, z, w)."""
    x, y, z, w = q
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    yaw = math.atan2(siny_cosp, cosy_cosp)
    return yaw


def normalize_angle(angle):
    """Normalize angle to [-pi, pi]."""
    while angle > math.pi:
        angle -= 2 * math.pi
    while angle < -math.pi:
        angle += 2 * math.pi
    return angle


# ---------------------------------------------------------------------------
# Dynamic decel-zone computation
# ---------------------------------------------------------------------------

# Per-axis fallback minimums (fine-control floor) and accel defaults.
_DECEL_DEFAULTS = {
    'a_max_linear':  0.5,    # m/s²   — conservative linear accel fallback
    'a_max_angular': 1.0,    # rad/s² — conservative angular accel fallback
    'v_min_x':       0.125,  # m/s    — fine-control floor, linear x
    'v_min_y':       0.100,  # m/s    — fine-control floor, linear y
    'omega_min':     0.375,  # rad/s  — fine-control floor, angular z
}

# Param keyword groups (searched case-insensitively, first numeric match wins).
_ACCEL_KEYWORDS     = ['max_accel', 'accel_limit', 'decel_limit']
_ANG_ACCEL_KEYWORDS = ['max_ang_accel', 'ang_accel_limit', 'angular_accel_limit']
_MIN_VEL_KEYWORDS   = ['min_vel_x', 'min_vel', 'min_speed', 'speed_limit_min']
_MIN_ANG_VEL_KEYWORDS = ['min_ang_vel', 'min_angular_speed', 'min_angular_vel']


def _fetch_first_param(node, nodes_to_search, keywords, deadline):
    """Scan *nodes_to_search* for any param whose name contains a keyword.

    Returns (float_value, "node_name:param_name") or (None, "defaults").
    Stops as soon as one numeric value is found, or when *deadline* (epoch s) passes.
    """
    from rcl_interfaces.srv import ListParameters, GetParameters

    for node_name in nodes_to_search:
        if time.time() >= deadline:
            break
        try:
            list_client = node.create_client(ListParameters, f"{node_name}/list_parameters")
            svc_timeout = max(0.1, min(1.0, deadline - time.time()))
            if not list_client.wait_for_service(timeout_sec=svc_timeout):
                continue

            future = list_client.call_async(ListParameters.Request())
            while time.time() < deadline and not future.done():
                rclpy.spin_once(node, timeout_sec=0.05)
            if not future.done():
                future.cancel()
                continue

            result = future.result()
            names = result.result.names if result and result.result else []
            kws_lower = [k.lower() for k in keywords]
            matched = [n for n in names if any(kw in n.lower() for kw in kws_lower)]
            if not matched:
                continue

            get_client = node.create_client(GetParameters, f"{node_name}/get_parameters")
            svc_timeout = max(0.1, min(1.0, deadline - time.time()))
            if not get_client.wait_for_service(timeout_sec=svc_timeout):
                continue

            req = GetParameters.Request()
            req.names = matched[:1]
            future2 = get_client.call_async(req)
            while time.time() < deadline and not future2.done():
                rclpy.spin_once(node, timeout_sec=0.05)
            if not future2.done():
                future2.cancel()
                continue

            values = future2.result().values if future2.result() else []
            if not values:
                continue

            pval = values[0]
            for attr in ('double_value', 'integer_value'):
                raw = getattr(pval, attr, None)
                if raw is not None and float(raw) > 0:
                    return float(raw), f"{node_name}:{matched[0]}"
        except Exception:
            continue

    return None, "defaults"


def compute_decel_params(msg_data, distance, is_rotation, is_degrees, node):
    """Auto-compute the decel zone (slow_zone) and slow_factor for publish-until.

    Uses kinematics:
      linear:   slow_zone = v_cmd² / (2 × a_max);  slow_factor = v_min / v_cmd
      rotation: slow_zone = ω_cmd² / (2 × α_max);  slow_factor = ω_min / ω_cmd

    Accel and min-vel values are fetched from live node params (2 s hard timeout).
    Falls back to _DECEL_DEFAULTS on any failure.

    Args:
        msg_data:    Parsed Twist or TwistStamped dict from the publish-until message.
        distance:    Total move in condition units (metres for linear, radians for rotation).
        is_rotation: True when using --rotate.
        is_degrees:  True when --degrees is set (affects display value in meta only).
        node:        A live ROS2CLI node to use for param service calls.

    Returns:
        (slow_zone, slow_factor, meta_dict)
        slow_zone is in condition units (metres or radians).
        meta_dict: {"auto_computed": True/False, "slow_last": X, "slow_factor": Y,
                    "params_source": "node:param" | "defaults"}
    """
    deadline = time.time() + 2.0  # hard 2-second cap for all param fetches

    # Unwrap TwistStamped → Twist
    twist = msg_data.get('twist', msg_data)
    linear  = twist.get('linear',  {})
    angular = twist.get('angular', {})

    # ------------------------------------------------------------------ rotation
    if is_rotation:
        omega_cmd = abs(angular.get('z', 0.0))
        if omega_cmd < 1e-6:
            return None, 0.25, {"auto_computed": False, "reason": "zero angular velocity"}

        try:
            node_info = node.get_node_names_and_namespaces()
            nodes_list = [f"{ns.rstrip('/')}/{n}" for n, ns in node_info]
        except Exception:
            nodes_list = []

        alpha_val, alpha_src = _fetch_first_param(node, nodes_list, _ANG_ACCEL_KEYWORDS, deadline)
        alpha_max = alpha_val if alpha_val else _DECEL_DEFAULTS['a_max_angular']

        omega_val, omega_src = _fetch_first_param(node, nodes_list, _MIN_ANG_VEL_KEYWORDS, deadline)
        omega_min = omega_val if omega_val else _DECEL_DEFAULTS['omega_min']

        # Kinematic braking distance (radians)
        raw_zone   = omega_cmd ** 2 / (2.0 * alpha_max)
        slow_zone  = max(math.radians(3.0), min(raw_zone, abs(distance) * 0.4))
        slow_factor = max(0.10, min(0.50, omega_min / omega_cmd))

        display_val  = math.degrees(slow_zone) if is_degrees else round(slow_zone, 4)
        params_source = alpha_src if alpha_src != "defaults" else omega_src

        meta = {
            "auto_computed": True,
            "slow_last":   round(display_val, 4),
            "slow_factor": round(slow_factor, 4),
            "params_source": params_source,
        }
        return slow_zone, slow_factor, meta

    # ------------------------------------------------------------------ linear
    vx = abs(linear.get('x', 0.0))
    vy = abs(linear.get('y', 0.0))

    if vx >= vy and vx > 1e-6:
        v_cmd, v_min_default, axis_kws = vx, _DECEL_DEFAULTS['v_min_x'], ['min_vel_x'] + _MIN_VEL_KEYWORDS
    elif vy > 1e-6:
        v_cmd, v_min_default, axis_kws = vy, _DECEL_DEFAULTS['v_min_y'], ['min_vel_y'] + _MIN_VEL_KEYWORDS
    else:
        return None, 0.25, {"auto_computed": False, "reason": "zero linear velocity"}

    try:
        node_info = node.get_node_names_and_namespaces()
        nodes_list = [f"{ns.rstrip('/')}/{n}" for n, ns in node_info]
    except Exception:
        nodes_list = []

    accel_val, accel_src = _fetch_first_param(node, nodes_list, _ACCEL_KEYWORDS, deadline)
    a_max = accel_val if accel_val else _DECEL_DEFAULTS['a_max_linear']

    vmin_val, vmin_src = _fetch_first_param(node, nodes_list, axis_kws, deadline)
    v_min = vmin_val if vmin_val else v_min_default

    raw_zone  = v_cmd ** 2 / (2.0 * a_max)
    slow_zone = max(0.05, min(raw_zone, abs(distance) * 0.4))
    slow_factor = max(0.10, min(0.50, v_min / v_cmd))

    params_source = accel_src if accel_src != "defaults" else vmin_src

    meta = {
        "auto_computed": True,
        "slow_last":   round(slow_zone, 4),
        "slow_factor": round(slow_factor, 4),
        "params_source": params_source,
    }
    return slow_zone, slow_factor, meta


def scale_twist_velocity(data, scale):
    """Return a copy of a Twist or TwistStamped dict with all velocity fields multiplied by scale."""
    d = copy.deepcopy(data)
    if 'twist' in d and isinstance(d.get('twist'), dict):
        # TwistStamped: velocity nested under 'twist' key
        for top in ('linear', 'angular'):
            if top in d['twist'] and isinstance(d['twist'][top], dict):
                for ax in ('x', 'y', 'z'):
                    if ax in d['twist'][top] and isinstance(d['twist'][top][ax], (int, float)):
                        d['twist'][top][ax] = d['twist'][top][ax] * scale
    else:
        # Twist: velocity at top level
        for top in ('linear', 'angular'):
            if top in d and isinstance(d[top], dict):
                for ax in ('x', 'y', 'z'):
                    if ax in d[top] and isinstance(d[top][ax], (int, float)):
                        d[top][ax] = d[top][ax] * scale
    return d


def _has_velocity_fields(data):
    """Return True if *data* looks like a Twist or TwistStamped message dict.

    Used to gate the auto-hold zero-velocity burst so it only fires for motion
    payloads and is silently skipped for other message types.
    """
    if not isinstance(data, dict):
        return False
    if 'linear' in data or 'angular' in data:
        return True
    nested = data.get('twist')
    return isinstance(nested, dict) and ('linear' in nested or 'angular' in nested)


def _clamp_velocity(data, max_linear=None, max_ang=None):
    """Return (clamped_data, notices).

    Clips linear x/y/z to ±max_linear and angular z to ±max_ang in a Twist
    or TwistStamped dict.  Non-velocity payloads pass through unchanged.
    Both limits are optional; passing None means "no clamp on that axis".
    """
    if max_linear is None and max_ang is None:
        return data, []
    if not _has_velocity_fields(data):
        return data, []

    d = copy.deepcopy(data)
    notices = []

    def _clamp_axis(container, key, axis, limit, label):
        if container and isinstance(container.get(key), dict):
            val = container[key].get(axis)
            if isinstance(val, (int, float)) and limit is not None:
                clamped = max(-limit, min(limit, val))
                if clamped != val:
                    container[key][axis] = clamped
                    notices.append(
                        f"{label}.{axis}: {val} → {clamped} (clamped to ±{limit})"
                    )

    if 'twist' in d and isinstance(d.get('twist'), dict):
        # TwistStamped — velocity nested under 'twist'
        t = d['twist']
        for ax in ('x', 'y', 'z'):
            _clamp_axis(t, 'linear', ax, max_linear, 'twist.linear')
        _clamp_axis(t, 'angular', 'z', max_ang, 'twist.angular')
    else:
        # Twist — velocity at top level
        for ax in ('x', 'y', 'z'):
            _clamp_axis(d, 'linear', ax, max_linear, 'linear')
        _clamp_axis(d, 'angular', 'z', max_ang, 'angular')

    return d, notices


class ConditionMonitor(Node):
    """Subscriber that evaluates a stop condition on every incoming message."""

    def __init__(self, topic, msg_type, field, operator, threshold, stop_event,
                 euclidean=False, rotate=None):
        super().__init__(_node_name('mon', topic))
        self.euclidean = euclidean
        self.rotate = rotate
        if isinstance(field, list):
            self.fields = field
            self.field = field[0]
        else:
            self.fields = [field]
            self.field = field
        self.operator = operator
        self.threshold = threshold
        self.stop_event = stop_event

        self.start_value = None
        self.current_value = None
        self.start_values = None
        self.current_values = None
        self.euclidean_distance = None

        # Rotation-specific
        self.start_yaw = None
        self.last_yaw = None
        self.accumulated_rotation = 0.0
        self.rotation_delta = None

        self.start_msg = None
        self.end_msg = None
        self.field_error = None
        self.lock = threading.Lock()
        self.sub = None

        msg_class = get_msg_type(msg_type)
        if msg_class:
            # Auto-match publisher QoS: use BEST_EFFORT if any publisher does,
            # so RELIABLE/BEST_EFFORT mismatches don't silently drop all messages.
            qos = qos_profile_system_default
            try:
                pub_infos = self.get_publishers_info_by_topic(topic)
                if any(p.qos_profile.reliability == ReliabilityPolicy.BEST_EFFORT
                       for p in pub_infos):
                    qos = qos_profile_sensor_data
            except Exception:
                pass
            self.sub = self.create_subscription(msg_class, topic, self.callback, qos)

    def callback(self, msg):
        with self.lock:
            if self.stop_event.is_set():
                return

            msg_dict = msg_to_dict(msg)

            if self.euclidean:
                values = []
                for fp in self.fields:
                    try:
                        v = resolve_field(msg_dict, fp)
                    except (KeyError, IndexError, TypeError) as e:
                        self.field_error = f"Field '{fp}' not found in monitor message: {e}"
                        self.stop_event.set()
                        return

                    if isinstance(v, dict):
                        numeric_children = [
                            (k, float(v[k]))
                            for k in sorted(v.keys())
                            if isinstance(v[k], (int, float))
                        ]
                        if not numeric_children:
                            self.field_error = (
                                f"Field '{fp}' resolves to a dict with no direct numeric "
                                f"sub-fields (keys: {sorted(v.keys())}). "
                                f"Specify a leaf field such as {fp}.x"
                            )
                            self.stop_event.set()
                            return
                        values.extend(val for _, val in numeric_children)
                    else:
                        try:
                            values.append(float(v))
                        except (TypeError, ValueError) as e:
                            self.field_error = f"Field '{fp}' not numeric in monitor message: {e}"
                            self.stop_event.set()
                            return

                if self.start_values is None:
                    self.start_values = values[:]
                    self.start_msg = msg_dict

                self.current_values = values
                dist = math.sqrt(
                    sum((c - s) ** 2 for c, s in zip(values, self.start_values))
                )
                self.euclidean_distance = dist

                if dist >= float(self.threshold):
                    self.end_msg = msg_dict
                    self.stop_event.set()

            elif self.rotate is not None:
                try:
                    quat = None
                    for path in ['pose.pose.orientation', 'orientation']:
                        try:
                            quat = resolve_field(msg_dict, path)
                            if quat and isinstance(quat, dict):
                                break
                        except (KeyError, IndexError, TypeError):
                            continue

                    if not quat or not isinstance(quat, dict):
                        self.field_error = "Could not find quaternion (pose.pose.orientation) in odometry message for rotation monitoring"
                        self.stop_event.set()
                        return

                    try:
                        qx = float(quat.get('x', 0))
                        qy = float(quat.get('y', 0))
                        qz = float(quat.get('z', 0))
                        qw = float(quat.get('w', 1))
                    except (TypeError, ValueError) as e:
                        self.field_error = f"Quaternion values must be numeric: {e}"
                        self.stop_event.set()
                        return

                    current_yaw = quaternion_to_yaw((qx, qy, qz, qw))

                    if self.start_yaw is None:
                        self.start_yaw = current_yaw
                        self.last_yaw = current_yaw
                        self.start_msg = msg_dict
                        return

                    step = normalize_angle(current_yaw - self.last_yaw)
                    self.accumulated_rotation += step
                    self.last_yaw = current_yaw
                    self.rotation_delta = self.accumulated_rotation

                    target = self.rotate
                    if target > 0 and self.accumulated_rotation >= target:
                        self.end_msg = msg_dict
                        self.stop_event.set()
                    elif target < 0 and self.accumulated_rotation <= target:
                        self.end_msg = msg_dict
                        self.stop_event.set()

                except Exception as e:
                    self.field_error = f"Rotation monitoring error: {e}"
                    self.stop_event.set()
                    return

            else:
                try:
                    value = resolve_field(msg_dict, self.field)
                except (KeyError, IndexError, TypeError, ValueError) as e:
                    self.field_error = f"Field '{self.field}' not found in monitor message: {e}"
                    self.stop_event.set()
                    return

                try:
                    numeric_value = float(value)
                except (TypeError, ValueError):
                    numeric_value = None

                if self.start_value is None:
                    self.start_value = value
                    self.start_msg = msg_dict

                self.current_value = value

                condition_met = False
                if self.operator == 'delta':
                    if numeric_value is not None and self.start_value is not None:
                        try:
                            delta = numeric_value - float(self.start_value)
                            thr = float(self.threshold)
                            condition_met = delta >= thr if thr >= 0 else delta <= thr
                        except (TypeError, ValueError):
                            pass
                elif self.operator == 'above':
                    if numeric_value is not None:
                        condition_met = numeric_value > float(self.threshold)
                elif self.operator == 'below':
                    if numeric_value is not None:
                        condition_met = numeric_value < float(self.threshold)
                elif self.operator == 'equals':
                    if numeric_value is not None:
                        try:
                            condition_met = abs(numeric_value - float(self.threshold)) < 1e-9
                        except (TypeError, ValueError):
                            condition_met = str(value) == str(self.threshold)
                    else:
                        condition_met = str(value) == str(self.threshold)

                if condition_met:
                    self.end_msg = msg_dict
                    self.stop_event.set()


# ---------------------------------------------------------------------------
# Hz monitor node
# ---------------------------------------------------------------------------

class HzMonitor(Node):
    """Subscriber that measures the publish rate of a topic."""

    def __init__(self, topic, msg_type, window, done_event):
        super().__init__('hz_monitor')
        self.window = window
        self.done_event = done_event
        self.timestamps = []
        self.lock = threading.Lock()
        self.sub = None

        msg_class = get_msg_type(msg_type)
        if msg_class:
            self.sub = self.create_subscription(
                msg_class, topic, self._callback, qos_profile_system_default
            )

    def _callback(self, msg):
        with self.lock:
            if self.done_event.is_set():
                return
            self.timestamps.append(time.time())
            if len(self.timestamps) >= self.window + 1:
                self.done_event.set()


# ---------------------------------------------------------------------------
# topics publish
# ---------------------------------------------------------------------------

def cmd_topics_publish(args):
    if not args.topic:
        return output({"error": "topic argument is required"})
    if args.msg is None:
        return output({"error": "msg argument is required"})

    try:
        msg_data = json.loads(args.msg)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        return output({"error": f"Invalid JSON message: {e}"})

    max_vel = getattr(args, 'max_vel', None)
    max_ang = getattr(args, 'max_ang', None)
    msg_data, clamp_notices = _clamp_velocity(msg_data, max_vel, max_ang)
    dry_run = getattr(args, 'dry_run', False)

    try:
        with ros2_context():
            topic = args.topic
            temp_node = ROS2CLI("temp")
            msg_type = resolve_topic_type(temp_node, topic, args.msg_type)
            temp_node.destroy_node()

            if not msg_type:
                return output({"error": f"Could not detect message type for topic: {topic}. Use --msg-type to specify."})

            msg_class = get_msg_type(msg_type)
            if not msg_class:
                return output(get_msg_error(msg_type))

            if dry_run:
                result = {"dry_run": True, "topic": topic, "msg_type": msg_type, "payload": msg_data}
                if clamp_notices:
                    result["velocity_clamped"] = clamp_notices
                return output(result)

            publisher = TopicPublisher(topic, msg_type)

            if publisher.pub is None:
                return output({"error": f"Failed to create publisher for {msg_type}"})

            msg = dict_to_msg(msg_class, msg_data)

            rate = getattr(args, "rate", None) or 10.0
            duration = getattr(args, "duration", None) or getattr(args, "timeout", None)
            interval = 1.0 / rate

            if duration and duration > 0:
                published = 0
                start_time = time.time()
                end_time = start_time + duration
                stopped_by = "timeout"
                try:
                    while time.time() < end_time:
                        publisher.pub.publish(msg)
                        published += 1
                        remaining = end_time - time.time()
                        if remaining > 0:
                            time.sleep(min(interval, remaining))
                except KeyboardInterrupt:
                    stopped_by = "keyboard_interrupt"
                elapsed = round(time.time() - start_time, 3)
                result = {"success": True, "topic": topic, "msg_type": msg_type,
                          "duration": elapsed, "rate": rate, "published_count": published,
                          "stopped_by": stopped_by}
                if clamp_notices:
                    result["velocity_clamped"] = clamp_notices
                output(result)
            else:
                publisher.pub.publish(msg)
                time.sleep(0.1)
                result = {"success": True, "topic": topic, "msg_type": msg_type}
                if clamp_notices:
                    result["velocity_clamped"] = clamp_notices
                output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_publish_sequence(args):
    if not args.topic:
        return output({"error": "topic argument is required"})
    if args.messages is None:
        return output({"error": "messages argument is required"})
    if args.durations is None:
        return output({"error": "durations argument is required"})

    try:
        messages = json.loads(args.messages)
        durations = json.loads(args.durations)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        return output({"error": f"Invalid JSON: {e}"})
    if len(messages) != len(durations):
        return output({"error": "messages and durations must have same length"})

    dry_run = getattr(args, 'dry_run', False)

    try:
        with ros2_context():
            topic = args.topic
            temp_node = ROS2CLI("temp")
            msg_type = resolve_topic_type(temp_node, topic, args.msg_type)
            temp_node.destroy_node()

            if not msg_type:
                return output({"error": f"Could not detect message type for topic: {topic}. Use --msg-type to specify."})

            msg_class = get_msg_type(msg_type)
            if not msg_class:
                return output(get_msg_error(msg_type))

            if dry_run:
                max_vel = getattr(args, 'max_vel', None)
                max_ang = getattr(args, 'max_ang', None)
                clamped = [_clamp_velocity(m, max_vel, max_ang)[0] for m in messages]
                return output({"dry_run": True, "topic": topic, "msg_type": msg_type,
                               "steps": [{"payload": m, "duration": d} for m, d in zip(clamped, durations)]})

            publisher = TopicPublisher(topic, msg_type)

            if publisher.pub is None:
                return output({"error": f"Failed to create publisher for {msg_type}"})

            rate = getattr(args, "rate", None) or 10.0
            interval = 1.0 / rate

            max_vel = getattr(args, 'max_vel', None)
            max_ang = getattr(args, 'max_ang', None)
            all_clamp_notices = []

            total_published = 0
            last_msg_data = messages[0] if messages else {}
            try:
                for msg_data, dur in zip(messages, durations):
                    msg_data, clamp_notices = _clamp_velocity(msg_data, max_vel, max_ang)
                    all_clamp_notices.extend(clamp_notices)
                    last_msg_data = msg_data
                    msg = dict_to_msg(msg_class, msg_data)
                    if dur > 0:
                        end_time = time.time() + dur
                        while time.time() < end_time:
                            publisher.pub.publish(msg)
                            total_published += 1
                            remaining = end_time - time.time()
                            if remaining > 0:
                                time.sleep(min(interval, remaining))
                    else:
                        publisher.pub.publish(msg)
                        total_published += 1
            finally:
                # Auto-hold: zero-velocity burst on any exit path (normal completion,
                # exception, or KeyboardInterrupt). Applies only to Twist / TwistStamped
                # payloads; silently skipped for other message types so non-motion
                # sequences are unaffected.
                if _has_velocity_fields(last_msg_data):
                    try:
                        zero_msg = dict_to_msg(msg_class, scale_twist_velocity(last_msg_data, 0.0))
                        for _ in range(3):
                            publisher.pub.publish(zero_msg)
                            time.sleep(0.05)
                    except Exception:
                        pass

            result = {"success": True, "published_count": total_published, "topic": topic,
                      "rate": rate}
            if all_clamp_notices:
                # Deduplicate while preserving order
                seen = set()
                unique_notices = [n for n in all_clamp_notices if not (n in seen or seen.add(n))]
                result["velocity_clamped"] = unique_notices
            output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_publish_until(args):
    """Publish to a topic until a condition on a monitor topic is met."""
    if not args.topic:
        return output({"error": "topic argument is required"})
    if args.msg is None:
        return output({"error": "msg argument is required"})
    if not args.monitor:
        return output({"error": "--monitor argument is required"})

    # Handle --rotate flag
    rotate_angle = getattr(args, 'rotate', None)
    use_degrees = getattr(args, 'degrees', False)

    if rotate_angle is not None:
        if args.field:
            return output({"error": "--rotate cannot be used with --field"})
        if args.euclidean:
            return output({"error": "--rotate cannot be used with --euclidean"})
        if args.delta or args.above or args.below or args.equals:
            return output({"error": "--rotate cannot be used with --delta, --above, --below, or --equals"})
        try:
            rotate_angle = float(rotate_angle)
        except (TypeError, ValueError):
            return output({"error": "--rotate must be a numeric value"})
        if use_degrees:
            rotate_angle = math.radians(rotate_angle)
        if rotate_angle == 0:
            return output({"error": "--rotate angle must be non-zero"})
        field_paths = ['pose.pose.orientation']
    else:
        if not args.field:
            return output({"error": "--field argument is required (or use --rotate for rotation)"})
        field_paths = args.field
    euclidean = getattr(args, 'euclidean', False)

    if rotate_angle is None and len(field_paths) > 1 and not euclidean:
        return output({"error": "Multiple --field paths require the --euclidean flag"})

    operator_map = {
        'delta': args.delta,
        'above': args.above,
        'below': args.below,
        'equals': args.equals,
    }
    active = {k: v for k, v in operator_map.items() if v is not None}
    if rotate_angle is None and len(active) != 1:
        return output({"error": "Specify exactly one of --delta, --above, --below, --equals (or --rotate for rotation)"})

    if euclidean and rotate_angle is None and next(iter(active)) != 'delta':
        return output({"error": "--euclidean requires --delta (threshold is the Euclidean distance from start)"})
    operator, threshold = next(iter(active.items())) if active else (None, None)
    if euclidean and operator == 'delta' and threshold <= 0:
        return output({"error": "--delta must be > 0 when --euclidean is used"})

    try:
        msg_data = json.loads(args.msg)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        return output({"error": f"Invalid JSON message: {e}"})

    max_vel = getattr(args, 'max_vel', None)
    max_ang = getattr(args, 'max_ang', None)
    msg_data, clamp_notices = _clamp_velocity(msg_data, max_vel, max_ang)
    dry_run = getattr(args, 'dry_run', False)

    try:
        with ros2_context():
            temp_node = ROS2CLI("temp")
            pub_msg_type = resolve_topic_type(temp_node, args.topic, args.msg_type)
            mon_msg_type = resolve_topic_type(temp_node, args.monitor, args.monitor_msg_type)
            temp_node.destroy_node()

            if not pub_msg_type:
                return output({"error": f"Could not detect message type for topic: {args.topic}. Use --msg-type."})
            if not mon_msg_type:
                return output({"error": f"Could not detect message type for monitor topic: {args.monitor}. Use --monitor-msg-type."})

            if dry_run:
                result = {"dry_run": True, "topic": args.topic, "msg_type": pub_msg_type,
                          "payload": msg_data, "monitor": args.monitor, "monitor_msg_type": mon_msg_type}
                if clamp_notices:
                    result["velocity_clamped"] = clamp_notices
                return output(result)

            pub_msg_class = get_msg_type(pub_msg_type)
            if not pub_msg_class:
                return output(get_msg_error(pub_msg_type))

            stop_event = threading.Event()
            publisher = TopicPublisher(args.topic, pub_msg_type)
            monitor = ConditionMonitor(
                args.monitor, mon_msg_type,
                field_paths if euclidean else field_paths[0],
                operator, threshold, stop_event,
                euclidean=euclidean,
                rotate=rotate_angle,
            )

            if publisher.pub is None:
                return output({"error": f"Failed to create publisher for {pub_msg_type}"})
            if monitor.sub is None:
                return output({"error": f"Could not load monitor message type: {mon_msg_type}"})

            msg = dict_to_msg(pub_msg_class, msg_data)

            executor = rclpy.executors.SingleThreadedExecutor()
            executor.add_node(publisher)
            executor.add_node(monitor)

            rate = args.rate or 10.0
            timeout = args.timeout
            interval = 1.0 / rate
            start_time = time.time()
            published_count = 0

            # Deceleration zone: auto-compute from kinematics, or use manual --slow-last override.
            slow_last_arg = getattr(args, 'slow_last', None)
            slow_factor   = max(0.0, min(1.0, getattr(args, 'slow_factor', 0.25)))
            slow_zone     = None
            decel_meta    = {"auto_computed": False}

            if slow_last_arg is not None:
                # Manual override: resolve to condition units (radians for --rotate --degrees).
                slow_zone = (
                    math.radians(slow_last_arg)
                    if (rotate_angle is not None and use_degrees)
                    else float(slow_last_arg)
                )
            else:
                # Auto-compute: derive slow_zone and slow_factor from commanded velocity + params.
                condition_distance = (
                    abs(rotate_angle) if rotate_angle is not None
                    else float(threshold) if threshold is not None else 0.0
                )
                param_node = ROS2CLI("decel_probe")
                try:
                    auto_zone, auto_factor, decel_meta = compute_decel_params(
                        msg_data,
                        distance=condition_distance,
                        is_rotation=(rotate_angle is not None),
                        is_degrees=use_degrees,
                        node=param_node,
                    )
                finally:
                    param_node.destroy_node()

                if auto_zone is not None:
                    slow_zone   = auto_zone
                    slow_factor = auto_factor

            try:
                while not stop_event.is_set():
                    if timeout and (time.time() - start_time) >= timeout:
                        break

                    publish_msg = msg
                    if slow_zone is not None and slow_zone > 0:
                        with monitor.lock:
                            if rotate_angle is not None:
                                remaining = max(0.0, abs(rotate_angle) - abs(monitor.accumulated_rotation or 0.0))
                            elif euclidean:
                                remaining = max(0.0, float(threshold) - (monitor.euclidean_distance or 0.0))
                            elif operator == 'delta' and monitor.start_value is not None and monitor.current_value is not None:
                                try:
                                    remaining = max(0.0, abs(float(threshold)) - abs(float(monitor.current_value) - float(monitor.start_value)))
                                except (TypeError, ValueError):
                                    remaining = None
                            else:
                                remaining = None

                        if remaining is not None and remaining < slow_zone:
                            scale = max(slow_factor, remaining / slow_zone)
                            if scale < 0.999:
                                publish_msg = dict_to_msg(pub_msg_class, scale_twist_velocity(msg_data, scale))

                    publisher.pub.publish(publish_msg)
                    published_count += 1
                    executor.spin_once(timeout_sec=interval)
            finally:
                stop_event.set()
                # Always send a zero-velocity burst after the loop to stop the robot,
                # regardless of whether the condition was met or the command timed out.
                zero_msg = dict_to_msg(pub_msg_class, scale_twist_velocity(msg_data, 0.0))
                for _ in range(10):
                    publisher.pub.publish(zero_msg)
                    time.sleep(0.05)

            elapsed = round(time.time() - start_time, 3)

            with monitor.lock:
                if monitor.field_error:
                    return output({"error": monitor.field_error})

                condition_met = monitor.end_msg is not None

                if euclidean:
                    base = {
                        "topic": args.topic,
                        "monitor_topic": args.monitor,
                        "fields": field_paths,
                        "operator": "euclidean_delta",
                        "threshold": threshold,
                        "start_values": monitor.start_values,
                        "end_values": monitor.current_values,
                        "euclidean_distance": monitor.euclidean_distance,
                        "duration": elapsed,
                        "published_count": published_count,
                    }
                elif getattr(args, 'rotate', None) is not None:
                    base = {
                        "topic": args.topic,
                        "monitor_topic": args.monitor,
                        "operator": "rotate",
                        "target_rotation": rotate_angle,
                        "target_rotation_degrees": math.degrees(rotate_angle),
                        "actual_rotation": monitor.rotation_delta,
                        "actual_rotation_degrees": math.degrees(monitor.rotation_delta) if monitor.rotation_delta is not None else None,
                        "duration": elapsed,
                        "published_count": published_count,
                    }
                else:
                    base = {
                        "topic": args.topic,
                        "monitor_topic": args.monitor,
                        "field": field_paths[0],
                        "operator": operator,
                        "threshold": threshold,
                        "start_value": monitor.start_value,
                        "end_value": monitor.current_value,
                        "duration": elapsed,
                        "published_count": published_count,
                    }

                clamp_extra = {"velocity_clamped": clamp_notices} if clamp_notices else {}
                if condition_met:
                    output({**base,
                            "success": True,
                            "condition_met": True,
                            "decel_zone": decel_meta,
                            "start_msg": monitor.start_msg,
                            "end_msg": monitor.end_msg,
                            **clamp_extra})
                else:
                    output({**base,
                            "success": False,
                            "condition_met": False,
                            "decel_zone": decel_meta,
                            "error": f"Timeout after {timeout}s: condition not met",
                            **clamp_extra})

    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# topics hz / find / bw / delay
# ---------------------------------------------------------------------------

def _run_monitor(topic, window, timeout, monitor_cls):
    """Probe topic type, construct monitor node, and spin until done.

    Must be called inside ros2_context().  Returns (monitor, error_dict).
    Caller should extract data from monitor.lock before the context exits.
    """
    probe = ROS2CLI()
    topic_types = dict(probe.get_topic_names_and_types())
    probe.destroy_node()

    if topic not in topic_types:
        return None, {"error": f"Topic '{topic}' not found in the ROS graph"}
    msg_type = topic_types[topic][0]

    done_event = threading.Event()
    monitor = monitor_cls(topic, msg_type, window, done_event)

    if monitor.sub is None:
        return None, {"error": f"Could not subscribe to '{topic}' with type '{msg_type}'"}

    executor = rclpy.executors.SingleThreadedExecutor()
    executor.add_node(monitor)

    def _spin():
        while not done_event.is_set():
            executor.spin_once(timeout_sec=0.1)

    t = threading.Thread(target=_spin, daemon=True)
    t.start()
    done_event.wait(timeout=timeout)
    t.join(timeout=1.0)
    return monitor, None


def cmd_topics_hz(args):
    """Measure the publish rate of a topic."""
    if not args.topic:
        return output({"error": "topic argument is required"})

    topic, window, timeout = args.topic, args.window, args.timeout
    try:
        with ros2_context():
            monitor, err = _run_monitor(topic, window, timeout, HzMonitor)
            if err:
                return output(err)
            with monitor.lock:
                timestamps = list(monitor.timestamps)

        if len(timestamps) < 2:
            return output({"error": f"Fewer than 2 messages received within {timeout}s on '{topic}'"})

        deltas = [timestamps[i + 1] - timestamps[i] for i in range(len(timestamps) - 1)]
        mean_delta = sum(deltas) / len(deltas)
        variance = sum((d - mean_delta) ** 2 for d in deltas) / len(deltas)
        output({
            "topic": topic,
            "rate": round(1.0 / mean_delta if mean_delta > 0 else 0.0, 4),
            "min_delta": round(min(deltas), 6),
            "max_delta": round(max(deltas), 6),
            "std_dev": round(variance ** 0.5, 6),
            "samples": len(deltas),
        })
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_find(args):
    """Find topics publishing a specific message type."""
    if not args.msg_type:
        return output({"error": "msg_type argument is required"})

    # Path A guard: refuse live discovery when the profile has this field.
    if not getattr(args, "ignore_profile", False):
        try:
            from ros2_profile import (
                load_profile_summary, check_topics_find_path_a,
            )
            summary = load_profile_summary()
            if summary:
                violation = check_topics_find_path_a(args.msg_type, summary)
                if violation:
                    return output(violation)
        except Exception:
            # Never fail-closed on the guard itself: if anything goes wrong
            # importing or reading the profile, fall through to the live call.
            pass

    target_raw = args.msg_type

    def _norm_msg(t):
        return re.sub(r'/msg/', '/', t)

    target_norm = _norm_msg(target_raw)

    try:
        with ros2_context():
            node = ROS2CLI()
            all_topics = node.get_topic_names_and_types()

        matched = [
            name for name, types in all_topics
            if any(_norm_msg(t) == target_norm for t in types)
        ]
        output({
            "message_type": target_raw,
            "topics": matched,
            "count": len(matched),
        })
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# Bw / delay monitor nodes
# ---------------------------------------------------------------------------

class BwMonitor(Node):
    """Subscriber that measures bandwidth by serializing each received message."""

    def __init__(self, topic, msg_type, window, done_event):
        super().__init__('bw_monitor')
        self.window = window
        self.done_event = done_event
        self.samples = []
        self.lock = threading.Lock()
        self.sub = None

        msg_class = get_msg_type(msg_type)
        if msg_class:
            self.sub = self.create_subscription(
                msg_class, topic, self._callback, qos_profile_system_default
            )

    def _callback(self, msg):
        with self.lock:
            if self.done_event.is_set():
                return
            try:
                import rclpy.serialization
                size = len(rclpy.serialization.serialize_message(msg))
            except Exception:
                size = 0
            self.samples.append((time.time(), size))
            if len(self.samples) >= self.window:
                self.done_event.set()


def _run_bw_multi(topic_types_dict, target_topics, window, timeout):
    """Run BwMonitor concurrently on multiple topics within the current ros2_context.

    Must be called inside ros2_context().  Returns ``(results, no_data)`` where
    ``results`` maps topic → stats dict for topics that got enough samples, and
    ``no_data`` is the list of topics that received fewer than 2 messages.
    """
    monitors = {}
    done_events = {}

    executor = rclpy.executors.MultiThreadedExecutor()

    for topic in target_topics:
        msg_type_str = topic_types_dict.get(topic, [None])[0]
        if not msg_type_str:
            continue
        done = threading.Event()
        mon = BwMonitor(topic, msg_type_str, window, done)
        if mon.sub is None:
            continue
        executor.add_node(mon)
        monitors[topic] = mon
        done_events[topic] = done

    if not monitors:
        return {}, []

    stop = threading.Event()

    def _spin():
        while not stop.is_set():
            executor.spin_once(timeout_sec=0.1)

    spin_thread = threading.Thread(target=_spin, daemon=True)
    spin_thread.start()

    deadline = time.time() + timeout
    for done in done_events.values():
        remaining = max(deadline - time.time(), 0.05)
        done.wait(timeout=remaining)

    stop.set()
    spin_thread.join(timeout=1.0)

    results = {}
    no_data = []
    for topic, mon in monitors.items():
        with mon.lock:
            samples = list(mon.samples)
        if len(samples) >= 2:
            duration = samples[-1][0] - samples[0][0]
            total_bytes = sum(s for _, s in samples)
            results[topic] = {
                "bw": round(total_bytes / duration if duration > 0 else 0.0, 4),
                "bytes_per_msg": round(total_bytes / len(samples), 2),
                "rate": round(len(samples) / duration if duration > 0 else 0.0, 4),
                "samples": len(samples),
            }
        else:
            no_data.append(topic)

    return results, no_data


def cmd_topics_bw(args):
    """Measure the bandwidth of one or more topics.

    Lyrical Luth: accepts multiple topic names or ``--all`` for every topic
    in the ROS graph.

    Single topic (backward-compatible output)::

        {"topic": "/odom", "bw": 12345.6, ...}

    Multiple topics or ``--all``::

        {"topics": {"/odom": {"bw": ...}, "/cmd_vel": {"bw": ...}}, "count": 2}
    """
    topics_arg = list(getattr(args, 'topics', None) or [])
    all_flag = getattr(args, 'all', False)
    window, timeout = args.window, args.timeout

    if not topics_arg and not all_flag:
        return output({"error": "Specify at least one topic or use --all"})

    try:
        with ros2_context():
            probe = ROS2CLI()
            topic_types = dict(probe.get_topic_names_and_types())
            probe.destroy_node()

            if all_flag:
                target_topics = list(topic_types.keys())
                per_timeout = min(timeout, 5.0)   # cap per-topic window for --all
            else:
                target_topics = topics_arg
                per_timeout = timeout

            if not target_topics:
                return output({"error": "No topics found in the ROS graph"})

            missing = [t for t in target_topics if t not in topic_types]
            valid = [t for t in target_topics if t in topic_types]

            if not valid:
                return output({"error": "None of the requested topics exist", "missing": missing})

            # Single topic — preserve original output format for backward compat
            if len(valid) == 1 and not all_flag:
                topic = valid[0]
                monitor, err = _run_monitor(topic, window, per_timeout, BwMonitor)
                if err:
                    return output(err)
                with monitor.lock:
                    samples = list(monitor.samples)
                if len(samples) < 2:
                    return output({
                        "error": f"Fewer than 2 messages received within {per_timeout}s on '{topic}'"
                    })
                duration = samples[-1][0] - samples[0][0]
                total_bytes = sum(s for _, s in samples)
                return output({
                    "topic": topic,
                    "bw": round(total_bytes / duration if duration > 0 else 0.0, 4),
                    "bytes_per_msg": round(total_bytes / len(samples), 2),
                    "rate": round(len(samples) / duration if duration > 0 else 0.0, 4),
                    "samples": len(samples),
                })

            # Multi-topic — concurrent monitoring
            results, no_data = _run_bw_multi(topic_types, valid, window, per_timeout)

        out = {"topics": results, "count": len(results)}
        if missing:
            out["not_found"] = missing
        if no_data:
            out["no_data"] = no_data
        output(out)
    except Exception as e:
        output({"error": str(e)})


class DelayMonitor(Node):
    """Subscriber that measures header.stamp to wall-clock latency."""

    def __init__(self, topic, msg_type, window, done_event):
        super().__init__('delay_monitor')
        self.window = window
        self.done_event = done_event
        self.delays = []
        self.lock = threading.Lock()
        self.header_missing = False
        self.sub = None

        msg_class = get_msg_type(msg_type)
        if msg_class:
            self.sub = self.create_subscription(
                msg_class, topic, self._callback, qos_profile_system_default
            )

    def _callback(self, msg):
        with self.lock:
            if self.done_event.is_set():
                return
            wall = time.time()
            if not (hasattr(msg, 'header') and hasattr(msg.header, 'stamp')):
                self.header_missing = True
                self.done_event.set()
                return
            stamp = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
            self.delays.append(wall - stamp)
            if len(self.delays) >= self.window:
                self.done_event.set()


def cmd_topics_delay(args):
    """Measure header.stamp to wall-clock latency for a topic."""
    if not args.topic:
        return output({"error": "topic argument is required"})

    topic, window, timeout = args.topic, args.window, args.timeout
    try:
        with ros2_context():
            monitor, err = _run_monitor(topic, window, timeout, DelayMonitor)
            if err:
                return output(err)
            with monitor.lock:
                delays = list(monitor.delays)
                header_missing = monitor.header_missing

        if header_missing:
            return output({"error": f"Topic '{topic}' messages have no header.stamp field"})
        if not delays:
            return output({"error": f"No messages received within {timeout}s on '{topic}'"})

        mean_delay = sum(delays) / len(delays)
        variance = sum((d - mean_delay) ** 2 for d in delays) / len(delays)
        output({
            "topic": topic,
            "mean_delay": round(mean_delay, 6),
            "min_delay": round(min(delays), 6),
            "max_delay": round(max(delays), 6),
            "std_dev": round(variance ** 0.5, 6),
            "samples": len(delays),
        })
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# topics capture-image
# ---------------------------------------------------------------------------

def cmd_topics_capture_image(args):
    """Capture an image from a ROS 2 image topic and save to .artifacts/ folder.

    Profile-aware: if a robot profile is available and the URDF indicates that
    the camera is mounted at a non-upright angle (e.g. upside-down = 180°
    roll), the captured image is automatically rotated before being saved so
    that every downstream consumer (Discord send, display, analysis) receives a
    correctly-oriented frame.  Pass ``--no-profile`` to skip this correction.
    """
    try:
        from sensor_msgs.msg import CompressedImage, Image
        import cv2
        import numpy as np
    except ImportError as e:
        return output({"error": f"Missing dependency for image capture: {e}"})

    topic = args.topic
    output_filename = args.output
    timeout = args.timeout
    img_type = args.type
    skip_profile = getattr(args, "no_profile", False)

    out_path = resolve_output_path(output_filename)

    # ── Profile-aware camera orientation ─────────────────────────────────────
    # Load the robot profile summary silently.  If unavailable (profile not yet
    # scanned, or --no-profile passed), proceed without any rotation.
    profile_rotation_deg = 0
    profile_applied = False
    profile_note = None
    if not skip_profile:
        try:
            from ros2_profile import load_profile_summary
            summary = load_profile_summary()
            if summary:
                # Filter sensor_mounts to visual sensors only.
                visual_types = {"camera", "depth_camera"}
                all_mounts = summary.get("sensor_mounts", [])
                visual = [m for m in all_mounts
                          if m.get("sensor_type") in visual_types]
                non_zero = [m for m in visual
                            if m.get("image_rotation_deg", 0) != 0]
                if non_zero:
                    profile_rotation_deg = non_zero[0]["image_rotation_deg"]
                    profile_applied = True
                    if len(non_zero) > 1:
                        profile_note = (
                            f"Multiple non-upright visual sensor mounts detected "
                            f"({[m['link'] for m in non_zero]}); applied "
                            f"rotation from first match: {non_zero[0]['link']}"
                        )
        except Exception:
            pass  # profile load is best-effort; never block image capture

    try:
        received = {}

        def cb(msg):
            received['msg'] = msg

        with ros2_context():
            node = rclpy.create_node('image_capture')

            if img_type == 'compressed' or (img_type == 'auto' and topic.endswith('/compressed')):
                node.create_subscription(CompressedImage, topic, cb, 10)
            else:
                node.create_subscription(Image, topic, cb, 10)

            start = time.time()
            while time.time() - start < timeout:
                rclpy.spin_once(node, timeout_sec=0.1)
                if 'msg' in received:
                    break

            node.destroy_node()

        if 'msg' not in received:
            return output({"error": f"No image received from {topic} within {timeout} seconds"})

        msg = received['msg']

        if isinstance(msg, CompressedImage):
            np_arr = np.frombuffer(msg.data, np.uint8)
            img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        elif isinstance(msg, Image):
            arr = np.frombuffer(msg.data, dtype=np.uint8)
            img = arr.reshape((msg.height, msg.width, -1))
        else:
            return output({"error": "Unknown image message type"})

        # ── Apply profile-driven rotation ─────────────────────────────────
        if profile_rotation_deg == 180:
            img = cv2.rotate(img, cv2.ROTATE_180)
        elif profile_rotation_deg == 90:
            img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        elif profile_rotation_deg == -90:
            img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)

        cv2.imwrite(out_path, img)

        result = {"success": True, "path": out_path,
                  "profile_applied": profile_applied}
        if profile_applied:
            result["image_rotated_deg"] = profile_rotation_deg
        if profile_note:
            result["profile_note"] = profile_note

        if getattr(args, "inline", False):
            import base64
            _, buf = cv2.imencode(
                ".jpg" if out_path.lower().endswith((".jpg", ".jpeg")) else
                ".png" if out_path.lower().endswith(".png") else ".jpg",
                img
            )
            result["image_base64"] = base64.b64encode(buf.tobytes()).decode("ascii")
            result["image_encoding"] = "jpeg" if out_path.lower().endswith((".jpg", ".jpeg")) else "png"

        output(result)
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_depth_point(args):
    """Extract depth at pixel (u, v) from a depth image topic.

    Supports two common depth encodings without requiring numpy or cv2:
      16UC1 — 16-bit unsigned int, raw value is millimetres → converted to metres
      32FC1 — 32-bit float, value is already in metres; NaN means no reading

    Returns:
      topic, u, v, encoding, width, height, depth_m (None when invalid), invalid (bool)
    """
    import struct
    import math as _math

    try:
        from sensor_msgs.msg import Image
    except ImportError as e:
        return output({"error": f"sensor_msgs not available: {e}"})

    topic = args.topic
    u = args.u
    v = args.v
    timeout = getattr(args, 'timeout', 5.0)

    try:
        received = {}

        def _cb(msg):
            if 'msg' not in received:
                received['msg'] = msg

        with ros2_context():
            node = rclpy.create_node('depth_point')
            node.create_subscription(Image, topic, _cb, qos_profile_sensor_data)

            start = time.time()
            while time.time() - start < timeout:
                rclpy.spin_once(node, timeout_sec=0.1)
                if 'msg' in received:
                    break

            node.destroy_node()

        if 'msg' not in received:
            return output({"error": f"No depth image received from {topic} within {timeout}s"})

        msg = received['msg']
        encoding = msg.encoding
        width = msg.width
        height = msg.height

        if u < 0 or u >= width or v < 0 or v >= height:
            return output({
                "error": f"Pixel ({u}, {v}) out of bounds for {width}×{height} image",
                "width": width,
                "height": height,
            })

        raw = bytes(msg.data)

        if encoding == "16UC1":
            offset = v * msg.step + u * 2
            depth_mm = struct.unpack_from('<H', raw, offset)[0]
            invalid = (depth_mm == 0)
            depth_m = None if invalid else round(depth_mm / 1000.0, 4)
        elif encoding == "32FC1":
            offset = v * msg.step + u * 4
            depth_m_raw = struct.unpack_from('<f', raw, offset)[0]
            invalid = _math.isnan(depth_m_raw) or _math.isinf(depth_m_raw)
            depth_m = None if invalid else round(depth_m_raw, 4)
        else:
            return output({
                "error": f"Unsupported depth encoding '{encoding}'. Expected 16UC1 or 32FC1.",
                "encoding": encoding,
                "hint": "Use 'topics type <topic>' to confirm this is a depth image topic.",
            })

        output({
            "topic": topic,
            "u": u,
            "v": v,
            "encoding": encoding,
            "width": width,
            "height": height,
            "depth_m": depth_m,
            "invalid": invalid,
        })
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

def _discover_diag_topics(node):
    """Return [{topic, type}] for every DiagnosticArray topic in the graph."""
    results = []
    for name, types in node.get_topic_names_and_types():
        for t in types:
            if t in DIAG_TYPES:
                results.append({"topic": name, "type": t})
                break
    return sorted(results, key=lambda x: x["topic"])


def _parse_diag_array(msg_dict):
    """Convert a msg_to_dict() DiagnosticArray into a clean status list."""
    status_list = []
    for s in msg_dict.get("status", []):
        level = s.get("level", 0)
        status_list.append({
            "level": level,
            "level_name": _DIAG_LEVEL_NAMES.get(level, str(level)),
            "name": s.get("name", ""),
            "message": s.get("message", ""),
            "hardware_id": s.get("hardware_id", ""),
            "values": [
                {"key": kv.get("key", ""), "value": kv.get("value", "")}
                for kv in s.get("values", [])
            ],
        })
    return status_list


def cmd_topics_diag_list(args):
    """List all topics that publish DiagnosticArray messages (discovered by type)."""
    try:
        with ros2_context():
            node = ROS2CLI()
            topics = _discover_diag_topics(node)
        output({"topics": topics, "count": len(topics)})
    except Exception as e:
        output({"error": str(e)})


def _collect_and_output_typed_topics(topic_data, msg_class, args, parse_fn, result_key):
    """Subscribe to topic_data topics, spin until messages arrive, output parsed results.

    Handles both duration mode (collect for N seconds) and timeout mode (first message
    per topic).  Must be called within ros2_context().
    """
    executor = rclpy.executors.SingleThreadedExecutor()
    subscribers = {}
    for t in topic_data:
        sub = TopicSubscriber(t["topic"], t["type"], msg_class=msg_class)
        subscribers[t["topic"]] = sub
        executor.add_node(sub)

    max_msgs = args.max_messages or 1
    timeout_sec = args.timeout

    if args.duration:
        end_time = time.time() + args.duration
        while time.time() < end_time:
            executor.spin_once(timeout_sec=0.1)
        results = []
        for topic_name, sub in subscribers.items():
            with sub.lock:
                msgs = sub.messages[:max_msgs]
            for msg_dict in msgs:
                results.append({
                    "topic": topic_name,
                    "stamp": msg_dict.get("header", {}).get("stamp", {}),
                    result_key: parse_fn(msg_dict),
                })
    else:
        end_time = time.time() + timeout_sec
        while time.time() < end_time:
            executor.spin_once(timeout_sec=0.1)
            if all(len(subscribers[t["topic"]].messages) > 0 for t in topic_data):
                break
        results = []
        for t in topic_data:
            topic_name = t["topic"]
            sub = subscribers[topic_name]
            with sub.lock:
                msgs = sub.messages[:]
            if msgs:
                results.append({
                    "topic": topic_name,
                    "stamp": msgs[0].get("header", {}).get("stamp", {}),
                    result_key: parse_fn(msgs[0]),
                })
            else:
                results.append({"topic": topic_name, "error": "Timeout — no message received"})
    output({"results": results, "topic_count": len(topic_data)})


def cmd_topics_diag(args):
    """Subscribe to diagnostic topics, auto-discovered by type.

    If --topic is given, use that specific topic.  Otherwise, find every topic
    whose type is DiagnosticArray and subscribe to all of them simultaneously.
    DiagnosticArray messages are decoded into a human-readable status list with
    level_name (OK / WARN / ERROR / STALE), name, message, hardware_id and
    key-value pairs.
    """
    try:
        with ros2_context():
            node = ROS2CLI("diag_temp")

            if args.topic:
                resolved_type = None
                for name, types in node.get_topic_names_and_types():
                    if name == args.topic:
                        resolved_type = types[0] if types else None
                        break
                if resolved_type is None:
                    return output({
                        "error": f"Could not detect type for topic '{args.topic}'",
                        "hint": "Ensure the topic is active. Use 'topics type <topic>' to inspect it.",
                    })
                diag_topics = [{"topic": args.topic, "type": resolved_type}]
            else:
                diag_topics = _discover_diag_topics(node)
                if not diag_topics:
                    return output({
                        "error": "No diagnostic topics found",
                        "hint": (
                            "Ensure diagnostics-publishing nodes are running. "
                            "Diagnostic topics may be named /diagnostics, "
                            "<node>/diagnostics, or any other name — they are "
                            "identified by their DiagnosticArray message type."
                        ),
                    })

            diag_class = None
            for t in ("diagnostic_msgs/msg/DiagnosticArray", "diagnostic_msgs/DiagnosticArray"):
                diag_class = get_msg_type(t)
                if diag_class:
                    break
            if diag_class is None:
                return output({
                    "error": "Could not load diagnostic_msgs/DiagnosticArray",
                    "hint": "Install the diagnostics package: sudo apt install ros-$ROS_DISTRO-diagnostics",
                })

            _collect_and_output_typed_topics(diag_topics, diag_class, args, _parse_diag_array, "status")
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# Battery monitoring
# ---------------------------------------------------------------------------

def _discover_battery_topics(node):
    """Return [{topic, type}] for every BatteryState topic in the graph."""
    results = []
    for name, types in node.get_topic_names_and_types():
        for t in types:
            if t in BATTERY_TYPES:
                results.append({"topic": name, "type": t})
                break
    return sorted(results, key=lambda x: x["topic"])


def _nan_to_none(v):
    """Return None for float NaN (which is invalid JSON); pass other values through."""
    if isinstance(v, float) and v != v:
        return None
    return v


def _parse_battery_state(msg_dict):
    """Convert a msg_to_dict() BatteryState into a clean summary dict.

    All float fields use NaN to signal 'unmeasured' per the sensor_msgs spec;
    those are converted to null so the output is valid JSON.  percentage is
    scaled from the 0.0–1.0 ROS convention to 0–100 for readability.
    """
    pct = msg_dict.get("percentage", float("nan"))
    status_code = msg_dict.get("power_supply_status", 0)
    health_code = msg_dict.get("power_supply_health", 0)
    tech_code = msg_dict.get("power_supply_technology", 0)

    raw_cell_v = msg_dict.get("cell_voltage", []) or []
    raw_cell_t = msg_dict.get("cell_temperature", []) or []

    return {
        "percentage": (pct * 100) if pct == pct else None,
        "voltage": _nan_to_none(msg_dict.get("voltage")),
        "current": _nan_to_none(msg_dict.get("current")),
        "charge": _nan_to_none(msg_dict.get("charge")),
        "capacity": _nan_to_none(msg_dict.get("capacity")),
        "design_capacity": _nan_to_none(msg_dict.get("design_capacity")),
        "temperature": _nan_to_none(msg_dict.get("temperature")),
        "present": msg_dict.get("present"),
        "power_supply_status": status_code,
        "status_name": _BATTERY_POWER_SUPPLY_STATUS.get(status_code, str(status_code)),
        "power_supply_health": health_code,
        "health_name": _BATTERY_POWER_SUPPLY_HEALTH.get(health_code, str(health_code)),
        "power_supply_technology": tech_code,
        "technology_name": _BATTERY_POWER_SUPPLY_TECHNOLOGY.get(tech_code, str(tech_code)),
        "cell_voltage": [_nan_to_none(v) for v in raw_cell_v],
        "cell_temperature": [_nan_to_none(v) for v in raw_cell_t],
        "location": msg_dict.get("location", ""),
        "serial_number": msg_dict.get("serial_number", ""),
    }


def cmd_topics_battery_list(args):
    """List all topics that publish BatteryState messages (discovered by type)."""
    try:
        with ros2_context():
            node = ROS2CLI()
            topics = _discover_battery_topics(node)
        output({"topics": topics, "count": len(topics)})
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_battery(args):
    """Subscribe to battery topics, auto-discovered by type.

    If --topic is given, use that specific topic.  Otherwise, find every topic
    whose type is BatteryState and subscribe to all of them simultaneously.
    BatteryState messages are decoded into a human-readable summary with
    percentage (0–100), voltage, current, charge, capacity, temperature,
    status_name, health_name, technology_name, location, and serial_number.
    """
    try:
        with ros2_context():
            node = ROS2CLI("battery_temp")

            if args.topic:
                resolved_type = None
                for name, types in node.get_topic_names_and_types():
                    if name == args.topic:
                        resolved_type = types[0] if types else None
                        break
                if resolved_type is None:
                    return output({
                        "error": f"Could not detect type for topic '{args.topic}'",
                        "hint": "Ensure the topic is active. Use 'topics type <topic>' to inspect it.",
                    })
                battery_topics = [{"topic": args.topic, "type": resolved_type}]
            else:
                battery_topics = _discover_battery_topics(node)
                if not battery_topics:
                    return output({
                        "error": "No battery topics found",
                        "hint": (
                            "Ensure battery-publishing nodes are running. "
                            "Battery topics may be named /battery_state, "
                            "<robot>/battery_state, or any other name — they are "
                            "identified by their BatteryState message type."
                        ),
                    })

            battery_class = None
            for t in ("sensor_msgs/msg/BatteryState", "sensor_msgs/BatteryState"):
                battery_class = get_msg_type(t)
                if battery_class:
                    break
            if battery_class is None:
                return output({
                    "error": "Could not load sensor_msgs/BatteryState",
                    "hint": "Install the sensor_msgs package: sudo apt install ros-$ROS_DISTRO-sensor-msgs",
                })

            _collect_and_output_typed_topics(battery_topics, battery_class, args, _parse_battery_state, "battery")
    except Exception as e:
        output({"error": str(e)})


def cmd_topics_qos_check(args):
    """Compare QoS profiles of all publishers and subscribers on a topic."""
    topic = args.topic
    timeout = getattr(args, 'timeout', 5.0)

    try:
        with ros2_context():
            node = ROS2CLI()

            pub_info = node.get_publishers_info_by_topic(topic)
            sub_info = node.get_subscriptions_info_by_topic(topic)

        def _qos_entry(info_item):
            q = info_item.qos_profile
            # ReliabilityPolicy and DurabilityPolicy are IntEnum-like in rclpy
            reliability = getattr(q.reliability, 'name', str(q.reliability))
            durability = getattr(q.durability, 'name', str(q.durability))
            node_ns = info_item.node_namespace.rstrip('/')
            return {
                "node": f"{node_ns}/{info_item.node_name}",
                "reliability": reliability,
                "durability": durability,
            }

        publishers = [_qos_entry(p) for p in pub_info]
        subscribers = [_qos_entry(s) for s in sub_info]

        if not publishers:
            return output({
                "topic": topic,
                "publisher_count": 0,
                "subscriber_count": len(subscribers),
                "publishers": publishers,
                "subscribers": subscribers,
                "compatible": False,
                "issues": ["no publisher on topic"],
                "suggestion": "Start a publisher on this topic first",
            })

        # Check compatibility: publisher reliability must be >= subscriber reliability.
        # In practice: if any subscriber is RELIABLE and any publisher is BEST_EFFORT,
        # they are incompatible (BEST_EFFORT pub cannot satisfy RELIABLE sub).
        issues = []
        for pub in publishers:
            for sub in subscribers:
                if (pub["reliability"] != sub["reliability"] and
                        sub["reliability"] == "RELIABLE" and
                        pub["reliability"] == "BEST_EFFORT"):
                    issues.append(
                        f"reliability mismatch: publisher {pub['reliability']} "
                        f"vs subscriber {sub['reliability']}"
                    )
                if pub["durability"] != sub["durability"]:
                    issues.append(
                        f"durability mismatch: publisher {pub['durability']} "
                        f"vs subscriber {sub['durability']}"
                    )

        # De-duplicate
        seen = set()
        unique_issues = []
        for issue in issues:
            if issue not in seen:
                seen.add(issue)
                unique_issues.append(issue)

        compatible = len(unique_issues) == 0

        if compatible:
            suggestion = "QoS is compatible — no flags needed"
        else:
            # Suggest matching pub reliability if that's the primary issue
            pub_rel = publishers[0]["reliability"] if publishers else "BEST_EFFORT"
            suggestion = (
                f"Add --qos-reliability {pub_rel.lower()} to your subscribe command "
                "to match the publisher"
            )

        output({
            "topic": topic,
            "publisher_count": len(publishers),
            "subscriber_count": len(subscribers),
            "publishers": publishers,
            "subscribers": subscribers,
            "compatible": compatible,
            "issues": unique_issues,
            "suggestion": suggestion,
        })
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# topics classify
# ---------------------------------------------------------------------------

# Message types that map to semantic roles.  Both the short form
# (geometry_msgs/Twist) and the qualified form (geometry_msgs/msg/Twist) are
# accepted because live ROS 2 graphs return the qualified form while some
# test stubs use the short form.

_MOTION_TYPES = {
    f"geometry_msgs{q}{t}"
    for q in ("/msg/", "/")
    for t in ("Twist", "TwistStamped")
} | {f"nav_msgs{q}Odometry" for q in ("/msg/", "/")}

_SENSOR_TYPES = {
    f"sensor_msgs{q}{t}"
    for q in ("/msg/", "/")
    for t in ("LaserScan", "Imu", "Range", "MagneticField",
              "NavSatFix", "BatteryState", "JointState")
}

_CAMERA_TYPES = {
    f"sensor_msgs{q}{t}"
    for q in ("/msg/", "/")
    for t in ("CompressedImage", "CameraInfo")
}
# Image is shared between camera and depth — name is the tiebreaker.
_IMAGE_TYPE = {f"sensor_msgs{q}Image" for q in ("/msg/", "/")}

_DEPTH_TYPES = {f"sensor_msgs{q}PointCloud2" for q in ("/msg/", "/")}

_DIAG_TYPES_CLASSIFY = {
    f"diagnostic_msgs{q}{t}"
    for q in ("/msg/", "/")
    for t in ("DiagnosticArray", "DiagnosticStatus")
}

_TF_TYPES = {f"tf2_msgs{q}TFMessage" for q in ("/msg/", "/")}

_BATTERY_TYPES_CLASSIFY = {f"sensor_msgs{q}BatteryState" for q in ("/msg/", "/")}
_JOINT_TYPES = {f"sensor_msgs{q}JointState" for q in ("/msg/", "/")}
_ODOM_TYPES = {f"nav_msgs{q}Odometry" for q in ("/msg/", "/")}
_LASER_TYPES = {f"sensor_msgs{q}LaserScan" for q in ("/msg/", "/")}
_PC2_TYPES = {f"sensor_msgs{q}PointCloud2" for q in ("/msg/", "/")}
_CAM_IMAGE_TYPES = {f"sensor_msgs{q}Image" for q in ("/msg/", "/")} | _CAMERA_TYPES


def _classify_topics(topics_and_types):
    """Classify a list of (topic_name, [type_str]) into semantic roles.

    Returns a dict with:
      - ``topics``: list of {topic, type, role}
      - ``by_role``: {role: [topic_name, ...]} for all seven roles
      - ``capabilities``: bool flags for common robot capability signals
    """
    roles = {r: [] for r in
             ("motion", "sensors", "camera", "depth", "diagnostics", "tf", "other")}
    entries = []

    caps = {k: False for k in
            ("can_move", "has_lidar", "has_camera", "has_depth",
             "has_odom", "has_battery", "has_arm", "has_nav2")}

    for name, types in topics_and_types:
        t = types[0] if types else ""

        # TF — match by name first (most reliable)
        if name in ("/tf", "/tf_static") or t in _TF_TYPES:
            role = "tf"

        # Diagnostics
        elif t in _DIAG_TYPES_CLASSIFY:
            role = "diagnostics"

        # Depth: PointCloud2 always; Image only when 'depth' appears in name
        elif t in _DEPTH_TYPES or (t in _IMAGE_TYPE and "depth" in name.lower()):
            role = "depth"

        # Camera: CameraInfo, CompressedImage, or Image with 'camera'/'rgb'/'color' in name
        elif t in _CAMERA_TYPES or (
            t in _IMAGE_TYPE and any(kw in name.lower()
                                     for kw in ("camera", "rgb", "color", "image"))
        ):
            role = "camera"

        # Motion: Twist, TwistStamped, Odometry
        elif t in _MOTION_TYPES:
            role = "motion"

        # Sensors: LaserScan, Imu, Range, MagneticField, NavSatFix,
        #          BatteryState, JointState (and anything leftover in sensor_msgs)
        elif t in _SENSOR_TYPES:
            role = "sensors"

        else:
            role = "other"

        entries.append({"topic": name, "type": t, "role": role})
        roles[role].append(name)

        # Capability signals
        if t in _MOTION_TYPES and any(kw in name.lower()
                                       for kw in ("cmd_vel", "velocity", "twist")):
            caps["can_move"] = True
        if t in _LASER_TYPES:
            caps["has_lidar"] = True
        if role == "camera":
            caps["has_camera"] = True
        if role == "depth":
            caps["has_depth"] = True
        if t in _ODOM_TYPES:
            caps["has_odom"] = True
        if t in _BATTERY_TYPES_CLASSIFY:
            caps["has_battery"] = True
        if t in _JOINT_TYPES or "arm" in name.lower():
            caps["has_arm"] = True
        if "navigate" in name.lower() or "nav2" in name.lower():
            caps["has_nav2"] = True

    return {"topics": entries, "by_role": roles, "capabilities": caps}


def cmd_topics_classify(args):
    """Classify all active topics into semantic roles and return capability summary."""
    try:
        with ros2_context():
            node = ROS2CLI()
            topics_and_types = node.get_topic_names_and_types()
        result = _classify_topics(topics_and_types)
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

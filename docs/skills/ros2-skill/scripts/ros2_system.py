#!/usr/bin/env python3
"""System-level commands: battery health, shutdown, reboot.

The ``system`` command group provides robot lifecycle and health commands that
sit above the topic / service layer:

- ``system battery`` — single-shot health snapshot with configurable critical /
  warning thresholds.  Auto-discovers ``sensor_msgs/BatteryState`` topics.
- ``system shutdown [--confirm]`` — gracefully shuts down the host OS.
  Attempts a ``/shutdown`` ROS service first; falls back to ``sudo shutdown now``.
- ``system reboot [--confirm]`` — same but reboots rather than powers off.
"""

import time

import rclpy

from ros2_utils import output, get_msg_type, ros2_context, ROS2CLI, run_cmd

# Re-use the battery helpers and TopicSubscriber from ros2_topic to avoid
# duplicating logic.  No circular dependency: ros2_topic does not import
# from ros2_system.
from ros2_topic import (
    TopicSubscriber,
    _discover_battery_topics,
    _parse_battery_state,
)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_CRITICAL_PCT = 20   # battery % below which health = "critical"
_DEFAULT_WARNING_PCT  = 30   # battery % below which health = "warning"
_DEFAULT_TIMEOUT_SEC  = 5    # seconds to wait for a BatteryState message


# ---------------------------------------------------------------------------
# Battery snapshot
# ---------------------------------------------------------------------------

def cmd_system_battery(args):
    """Single-shot battery health check with threshold alerting.

    Reads one ``sensor_msgs/BatteryState`` message from every battery topic
    on the graph (or a specific ``--topic``), applies configurable warning /
    critical percentage thresholds, and returns a structured health summary::

        {
          "health": "ok" | "warning" | "critical",
          "batteries": [{
            "topic": "/battery_state",
            "percentage": 68.4,
            "voltage": 12.1,
            "current": -1.2,
            "status_name": "DISCHARGING",
            "health_name": "GOOD",
            "critical": false,
            "warning": false,
            "threshold_pct": 20,
            "warn_pct": 30
          }],
          "count": 1,
          "action": "..."   # only present when warning or critical
        }

    Battery topics are identified by message type (``BATTERY_TYPES``), not by
    name, so they work regardless of namespace.
    """
    threshold_pct = getattr(args, "threshold", _DEFAULT_CRITICAL_PCT)
    warn_pct      = getattr(args, "warn",      _DEFAULT_WARNING_PCT)
    timeout_sec   = getattr(args, "timeout",   _DEFAULT_TIMEOUT_SEC)
    topic_arg     = getattr(args, "topic",     None)

    try:
        with ros2_context():
            node = ROS2CLI("system_battery_check")

            # ---- Resolve which topics to read --------------------------------
            if topic_arg:
                resolved_type = None
                for name, types in node.get_topic_names_and_types():
                    if name == topic_arg:
                        resolved_type = types[0] if types else None
                        break
                if resolved_type is None:
                    return output({
                        "error": f"Topic '{topic_arg}' not found or has no type",
                        "hint": (
                            "Ensure the battery-publishing node is running. "
                            "Use 'topics list' to check active topics."
                        ),
                    })
                battery_topics = [{"topic": topic_arg, "type": resolved_type}]
            else:
                battery_topics = _discover_battery_topics(node)
                if not battery_topics:
                    return output({
                        "error": "No battery topics found on the graph",
                        "hint": (
                            "Ensure the battery-publishing node is running. "
                            "Battery topics are identified by sensor_msgs/BatteryState type — "
                            "they may be named /battery_state, /<robot>/battery_state, etc. "
                            "Use 'topics battery-list' to verify."
                        ),
                    })

            # ---- Load the message class -------------------------------------
            battery_class = None
            for t in ("sensor_msgs/msg/BatteryState", "sensor_msgs/BatteryState"):
                battery_class = get_msg_type(t)
                if battery_class:
                    break
            if battery_class is None:
                return output({
                    "error": "Could not load sensor_msgs/BatteryState",
                    "hint": "Install: sudo apt install ros-$ROS_DISTRO-sensor-msgs",
                })

            # ---- Subscribe and wait for one message per topic ---------------
            executor = rclpy.executors.SingleThreadedExecutor()
            subscribers = {}
            for t in battery_topics:
                sub = TopicSubscriber(t["topic"], t["type"], msg_class=battery_class)
                subscribers[t["topic"]] = sub
                executor.add_node(sub)

            end_time = time.time() + timeout_sec
            while time.time() < end_time:
                executor.spin_once(timeout_sec=0.1)
                if all(len(subscribers[t["topic"]].messages) > 0
                       for t in battery_topics):
                    break

            # ---- Process results -------------------------------------------
            results = []
            for t in battery_topics:
                topic_name = t["topic"]
                sub = subscribers[topic_name]
                with sub.lock:
                    msgs = sub.messages[:]

                if not msgs:
                    results.append({
                        "topic": topic_name,
                        "error": "Timeout — no message received",
                        "hint": (
                            f"Increase --timeout (current: {timeout_sec}s) "
                            "or check that the publisher is active."
                        ),
                    })
                    continue

                parsed = _parse_battery_state(msgs[0])
                pct = parsed.get("percentage")   # 0–100 or None

                critical = (pct is not None) and (pct < threshold_pct)
                warning  = (not critical) and (pct is not None) and (pct < warn_pct)

                entry = {
                    "topic":        topic_name,
                    "percentage":   pct,
                    "voltage":      parsed.get("voltage"),
                    "current":      parsed.get("current"),
                    "status_name":  parsed.get("status_name"),
                    "health_name":  parsed.get("health_name"),
                    "present":      parsed.get("present"),
                    "critical":     critical,
                    "warning":      warning,
                    "threshold_pct": threshold_pct,
                    "warn_pct":     warn_pct,
                }
                # Include optional fields only when non-empty
                location = parsed.get("location", "")
                if location:
                    entry["location"] = location

                results.append(entry)

        # ---- Overall health summary ----------------------------------------
        any_critical = any(r.get("critical") for r in results)
        any_warning  = any(r.get("warning")  for r in results)

        health = "critical" if any_critical else ("warning" if any_warning else "ok")

        response: dict = {
            "health":  health,
            "batteries": results,
            "count":   len(results),
        }
        if any_critical:
            response["action"] = (
                f"STOP — one or more batteries are below the critical threshold "
                f"({threshold_pct}%). Halt operation and charge immediately."
            )
        elif any_warning:
            response["action"] = (
                f"WARNING — one or more batteries are below the warning threshold "
                f"({warn_pct}%). Complete the current task, then charge."
            )

        return output(response)

    except Exception as e:
        return output({"error": str(e)})


# ---------------------------------------------------------------------------
# Shutdown / reboot
# ---------------------------------------------------------------------------

def _try_ros_service(service_name: str, timeout_sec: int = 5) -> bool:
    """Return True if *service_name* exists in the live graph."""
    stdout, _, rc = run_cmd(
        f"ros2 service list 2>/dev/null | grep -F '{service_name}'",
        timeout=timeout_sec * 1000,
    )
    return rc == 0 and service_name in stdout


def cmd_system_shutdown(args):
    """Shut down the host OS gracefully.

    Attempts to call a ``/shutdown`` ROS service first (if one is detected).
    Falls back to ``sudo shutdown now``.  The ``--confirm`` flag is **required**
    to prevent accidental shutdown — the command exits with an error if it is
    omitted.

    .. warning::
        This command shuts down the entire system, not just ROS.  It is
        intended for battery-powered robots that need a clean power-off
        before unplugging.  Never run it over an SSH connection you care
        about keeping alive.
    """
    if not getattr(args, "confirm", False):
        return output({
            "error": "Safety interlock: --confirm flag required",
            "hint": (
                "Re-run with --confirm to actually shut down the robot. "
                "This will power off the entire system."
            ),
        })

    # Try a ROS /shutdown service first
    for svc_name in ("/shutdown", "/system/shutdown"):
        if _try_ros_service(svc_name):
            _, stderr, rc = run_cmd(
                f"ros2 service call {svc_name} std_srvs/srv/Trigger {{}}",
                timeout=10_000,
            )
            if rc == 0:
                return output({
                    "success": True,
                    "method": "ros_service",
                    "service": svc_name,
                    "message": "Shutdown initiated via ROS service",
                })

    # Fall back to system shutdown
    _, stderr, rc = run_cmd("sudo shutdown now 2>&1", timeout=15_000)
    if rc == 0:
        return output({
            "success": True,
            "method": "sudo_shutdown",
            "message": "System shutdown initiated",
        })
    return output({
        "error": "Failed to initiate system shutdown",
        "stderr": stderr,
        "hint": (
            "Ensure this process has sudo privileges or a /shutdown ROS service "
            "is available. Check with 'services list'."
        ),
    })


def cmd_system_reboot(args):
    """Reboot the host OS.

    Behaviour mirrors ``system shutdown`` — requires ``--confirm``, tries a
    ``/reboot`` ROS service first, then falls back to ``sudo reboot``.
    """
    if not getattr(args, "confirm", False):
        return output({
            "error": "Safety interlock: --confirm flag required",
            "hint": (
                "Re-run with --confirm to actually reboot the robot. "
                "This will restart the entire system."
            ),
        })

    for svc_name in ("/reboot", "/system/reboot"):
        if _try_ros_service(svc_name):
            _, stderr, rc = run_cmd(
                f"ros2 service call {svc_name} std_srvs/srv/Trigger {{}}",
                timeout=10_000,
            )
            if rc == 0:
                return output({
                    "success": True,
                    "method": "ros_service",
                    "service": svc_name,
                    "message": "Reboot initiated via ROS service",
                })

    _, stderr, rc = run_cmd("sudo reboot 2>&1", timeout=15_000)
    if rc == 0:
        return output({
            "success": True,
            "method": "sudo_reboot",
            "message": "System reboot initiated",
        })
    return output({
        "error": "Failed to initiate system reboot",
        "stderr": stderr,
        "hint": (
            "Ensure this process has sudo privileges or a /reboot ROS service "
            "is available. Check with 'services list'."
        ),
    })


if __name__ == "__main__":
    import sys as _sys
    _mod = __import__("os").path.basename(__file__)
    _cli = __import__("os").path.join(
        __import__("os").path.dirname(__import__("os").path.abspath(__file__)),
        "ros2_cli.py",
    )
    print(
        f"[ros2-skill] '{_mod}' is an internal module — do not run it directly.\n"
        "Use the main entry point:\n"
        f"  python3 {_cli} <command> [subcommand] [args]\n"
        f"See all commands:  python3 {_cli} --help",
        file=_sys.stderr,
    )
    _sys.exit(1)

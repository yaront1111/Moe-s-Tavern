#!/usr/bin/env python3
"""ROS 2 doctor system health check commands."""

import socket
import struct
import threading
import time

import rclpy

from ros2_utils import ROS2CLI, output, ros2_context


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_meta():
    """Return importlib.metadata module, or None if unavailable."""
    try:
        import importlib.metadata as _meta
        return _meta
    except ImportError:
        try:
            import importlib_metadata as _meta  # fallback for older Pythons
            return _meta
        except ImportError:
            return None


def _load_entry_points(group):
    """Load entry points for *group*. Returns (eps_list, error_str_or_None)."""
    meta = _get_meta()
    if meta is None:
        return None, "importlib.metadata not available"
    try:
        return list(meta.entry_points(group=group)), None
    except Exception as exc:
        return None, f"Failed to load {group}: {exc}"


def _run_checks(exclude_packages=False):
    """Load and run all ros2doctor checkers via entry points.

    Returns (list_of_raw_check_dicts, error_string_or_None).
    Each dict has keys: name, errors (int), warnings (int), and optionally detail.
    """
    eps, err = _load_entry_points("ros2doctor.checks")
    if err:
        return None, err
    if not eps:
        return None, "No ros2doctor checkers found. Is ros2doctor installed? Source ROS 2 setup.bash."

    results = []
    for ep in eps:
        if exclude_packages and "package" in ep.name.lower():
            continue
        try:
            result = ep.load()().check()
            results.append({"name": ep.name, "errors": getattr(result, "error", 0),
                            "warnings": getattr(result, "warning", 0)})
        except Exception as exc:
            results.append({"name": ep.name, "errors": 1, "warnings": 0, "detail": str(exc)})
    return results, None


def _run_reports(exclude_packages=False):
    """Load all ros2doctor reporters via entry points.

    Returns a list of report dicts: {name, items: [[key, value], ...]}.
    """
    eps, err = _load_entry_points("ros2doctor.report")
    if err or not eps:
        return []

    reports = []
    for ep in eps:
        if exclude_packages and "package" in ep.name.lower():
            continue
        try:
            report = ep.load()().report()
            reports.append({"name": getattr(report, "name", ep.name),
                            "items": [[str(k), str(v)] for k, v in getattr(report, "items", [])]})
        except Exception:
            pass
    return reports


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_doctor_check(args):
    """Run ROS 2 system health checks and output a JSON summary."""
    try:
        raw_checks, err = _run_checks(exclude_packages=args.exclude_packages)
        if err:
            output({"error": err})
            return

        checks = []
        for c in raw_checks:
            if c["errors"]:
                status = "FAIL"
            elif c["warnings"]:
                status = "FAIL" if args.include_warnings else "WARN"
            else:
                status = "PASS"

            entry = {
                "name": c["name"],
                "status": status,
                "errors": c["errors"],
                "warnings": c["warnings"],
            }
            if "detail" in c:
                entry["detail"] = c["detail"]
            checks.append(entry)

        failed = sum(1 for c in checks if c["status"] == "FAIL")
        warned  = sum(1 for c in checks if c["status"] == "WARN")
        passed  = len(checks) - failed - warned
        overall = "FAIL" if failed else ("WARN" if warned else "PASS")

        out = {
            "summary": {
                "total":  len(checks),
                "passed": passed,
                "failed": failed,
                "warned": warned,
                "overall": overall,
            },
            "checks": checks,
        }

        if args.report or args.report_failed:
            reports = _run_reports(exclude_packages=args.exclude_packages)
            if args.report_failed:
                failed_names = {c["name"] for c in checks if c["status"] == "FAIL"}
                reports = [
                    r for r in reports
                    if any(fn in r["name"] or r["name"] in fn for fn in failed_names)
                ]
            out["reports"] = reports

        output(out)
    except Exception as exc:
        output({"error": str(exc)})


def cmd_doctor_hello(args):
    """Check cross-host connectivity via ROS topic and UDP multicast."""
    try:
        from std_msgs.msg import String

        hostname = socket.gethostname()
        topic    = args.topic
        timeout  = args.timeout

        MCAST_GRP  = "225.0.0.1"
        MCAST_PORT = 49150

        ros_heard   = set()
        mcast_heard = set()
        lock        = threading.Lock()

        def _on_ros_msg(msg):
            data = msg.data.strip()
            if hostname in data:
                return
            with lock:
                ros_heard.add(data)

        def _udp_receiver():
            try:
                sock = socket.socket(
                    socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP
                )
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(("", MCAST_PORT))
                mreq = struct.pack(
                    "4sl", socket.inet_aton(MCAST_GRP), socket.INADDR_ANY
                )
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
                sock.settimeout(0.5)
                end = time.time() + timeout
                while time.time() < end:
                    try:
                        data, addr = sock.recvfrom(1024)
                        text = data.decode("utf-8", errors="ignore").strip()
                        if hostname not in text:
                            with lock:
                                mcast_heard.add(addr[0])
                    except socket.timeout:
                        pass
                sock.close()
            except Exception:
                pass

        def _udp_sender():
            try:
                sock = socket.socket(
                    socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP
                )
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 32)
                payload = f"hello, it's me {hostname}".encode("utf-8")
                end = time.time() + timeout
                while time.time() < end:
                    sock.sendto(payload, (MCAST_GRP, MCAST_PORT))
                    time.sleep(0.5)
                sock.close()
            except Exception:
                pass

        recv_thread = threading.Thread(target=_udp_receiver, daemon=True)
        send_thread = threading.Thread(target=_udp_sender,   daemon=True)
        recv_thread.start()
        send_thread.start()

        msg      = String()
        msg.data = f"hello, it's me {hostname}"

        with ros2_context():
            node       = ROS2CLI()
            publisher  = node.create_publisher(String, topic, 10)
            node.create_subscription(String, topic, _on_ros_msg, 10)
            end_time = time.time() + timeout
            while time.time() < end_time:
                publisher.publish(msg)
                rclpy.spin_once(node, timeout_sec=0.1)

        recv_thread.join(timeout=1.0)

        output({
            "published": {
                "topic":     topic,
                "multicast": f"{MCAST_GRP}:{MCAST_PORT}",
                "message":   msg.data,
            },
            "ros_topic_heard_from":  sorted(ros_heard),
            "multicast_heard_from":  sorted(mcast_heard),
            "total_ros_hosts":       len(ros_heard),
            "total_multicast_hosts": len(mcast_heard),
        })
    except Exception as exc:
        output({"error": str(exc)})


def cmd_doctor_diagnostics(args):
    """Subscribe to /diagnostics_agg and report per-component hardware health.

    Returns a list of components with their status (OK / WARN / ERROR / STALE),
    optionally filtered by minimum level.  This covers hardware health that
    ros2doctor does not: motor temperatures, battery voltage, sensor faults, etc.
    """
    _LEVEL_MAP = {0: "OK", 1: "WARN", 2: "ERROR", 3: "STALE"}
    _MIN_LEVEL = {"ok": 0, "warn": 1, "warning": 1, "error": 2, "stale": 3}

    min_level = _MIN_LEVEL.get((getattr(args, "level", None) or "ok").lower(), 0)
    timeout = getattr(args, "timeout", 5.0)
    topic = getattr(args, "topic", "/diagnostics_agg")

    components = {}
    lock = threading.Lock()

    def _on_msg(msg):
        with lock:
            for status in msg.status:
                components[status.name] = {
                    "level": _LEVEL_MAP.get(status.level, f"LEVEL_{status.level}"),
                    "level_int": int(status.level),
                    "message": status.message,
                    "hardware_id": status.hardware_id,
                }

    try:
        from diagnostic_msgs.msg import DiagnosticArray  # noqa: PLC0415
    except ImportError:
        return output({"error": "diagnostic_msgs not available — source ROS 2 setup.bash"})

    try:
        with ros2_context():
            node = ROS2CLI()
            node.create_subscription(DiagnosticArray, topic, _on_msg, 10)
            end = time.time() + timeout
            while time.time() < end:
                rclpy.spin_once(node, timeout_sec=0.1)
                with lock:
                    if components:
                        break

        with lock:
            filtered = {
                name: info for name, info in components.items()
                if info["level_int"] >= min_level
            }

        counts = {"ok": 0, "warn": 0, "error": 0, "stale": 0}
        for info in filtered.values():
            counts[info["level"].lower()] = counts.get(info["level"].lower(), 0) + 1

        output({
            "topic": topic,
            "components_total": len(components),
            "components_shown": len(filtered),
            "filter_level": _LEVEL_MAP.get(min_level, "OK"),
            "summary": counts,
            "components": filtered,
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

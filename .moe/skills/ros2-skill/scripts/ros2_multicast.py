#!/usr/bin/env python3
"""ROS 2 multicast send/receive commands."""

import socket
import struct
import time

from ros2_utils import output


# Default multicast group and port — matches ros2 multicast / doctor hello
MCAST_GRP  = "225.0.0.1"
MCAST_PORT = 49150
MCAST_MSG  = "Hello, multicast!"


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_multicast_send(args):
    """Send one UDP multicast datagram and report what was sent."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 32)
        payload = MCAST_MSG.encode("utf-8")
        sock.sendto(payload, (args.group, args.port))
        sock.close()
        output({
            "sent": {
                "group":   args.group,
                "port":    args.port,
                "message": MCAST_MSG,
            },
        })
    except Exception as exc:
        output({"error": str(exc)})


def cmd_multicast_receive(args):
    """Listen for UDP multicast packets and report all received within timeout."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", args.port))
        mreq = struct.pack("4sl", socket.inet_aton(args.group), socket.INADDR_ANY)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        sock.settimeout(0.5)

        received = []
        end = time.time() + args.timeout
        while time.time() < end:
            try:
                data, (ip, _port) = sock.recvfrom(1024)
                text = data.decode("utf-8", errors="replace").strip()
                received.append({"from": ip, "message": text})
            except socket.timeout:
                pass
        sock.close()

        output({
            "received": received,
            "total":    len(received),
            "group":    args.group,
            "port":     args.port,
            "timeout":  args.timeout,
        })
    except Exception as exc:
        output({"error": str(exc)})


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

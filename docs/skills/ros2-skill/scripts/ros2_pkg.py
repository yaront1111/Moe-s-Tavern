#!/usr/bin/env python3
"""ROS 2 package commands.

Implements pkg list, prefix, executables, xml, and create using
ament_index_python (for introspection) and subprocess (for create).
No rclpy.init() or running ROS 2 graph required.
"""

import os
import pathlib
import subprocess

from ros2_utils import output


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_pkg_list(args):
    """List all installed ROS 2 packages.

    Reads the ament index to enumerate every package registered on this
    system.  No rclpy.init() or live ROS 2 graph required.
    """
    try:
        from ament_index_python.packages import get_packages_with_prefixes
    except ImportError as exc:
        output({
            "error": "ament_index_python is required: pip install ament-index-python",
            "detail": str(exc),
        })
        return

    try:
        packages = sorted(get_packages_with_prefixes().keys())
        output({"packages": packages, "total": len(packages)})
    except Exception as exc:
        output({"error": f"Failed to query ament index: {exc}"})


def cmd_pkg_prefix(args):
    """Output the prefix path of a ROS 2 package.

    No rclpy.init() or live ROS 2 graph required.
    """
    try:
        from ament_index_python.packages import get_package_prefix
    except ImportError as exc:
        output({
            "error": "ament_index_python is required: pip install ament-index-python",
            "detail": str(exc),
        })
        return

    try:
        prefix = get_package_prefix(args.package)
        output({"package": args.package, "prefix": prefix})
    except KeyError:
        output({"error": f"Package '{args.package}' not found. Is it installed and sourced?"})
    except Exception as exc:
        output({"error": str(exc)})


def cmd_pkg_executables(args):
    """List executables provided by a ROS 2 package.

    Walks <prefix>/lib/<package>/ and returns all executable files.
    No rclpy.init() or live ROS 2 graph required.
    """
    try:
        from ament_index_python.packages import get_package_prefix
    except ImportError as exc:
        output({
            "error": "ament_index_python is required: pip install ament-index-python",
            "detail": str(exc),
        })
        return

    try:
        prefix = get_package_prefix(args.package)
    except KeyError:
        output({"error": f"Package '{args.package}' not found. Is it installed and sourced?"})
        return
    except Exception as exc:
        output({"error": str(exc)})
        return

    lib_dir = pathlib.Path(prefix) / "lib" / args.package
    executables = []

    if lib_dir.is_dir():
        for entry in sorted(lib_dir.iterdir()):
            if entry.is_file() and os.access(entry, os.X_OK):
                executables.append(entry.name)

    output({
        "package":     args.package,
        "executables": executables,
        "total":       len(executables),
        "lib_dir":     str(lib_dir),
    })


def cmd_pkg_xml(args):
    """Output the package.xml of a ROS 2 package.

    Reads <prefix>/share/<package>/package.xml from the filesystem.
    No rclpy.init() or live ROS 2 graph required.
    """
    try:
        from ament_index_python.packages import get_package_share_directory
    except ImportError as exc:
        output({
            "error": "ament_index_python is required: pip install ament-index-python",
            "detail": str(exc),
        })
        return

    try:
        share_dir = get_package_share_directory(args.package)
    except KeyError:
        output({"error": f"Package '{args.package}' not found. Is it installed and sourced?"})
        return
    except Exception as exc:
        output({"error": str(exc)})
        return

    xml_path = pathlib.Path(share_dir) / "package.xml"

    if not xml_path.exists():
        output({
            "error": f"package.xml not found at '{xml_path}'.",
            "hint":  "The package is registered in the ament index but its share directory is missing.",
        })
        return

    try:
        content = xml_path.read_text(encoding="utf-8")
        output({"package": args.package, "path": str(xml_path), "xml": content})
    except Exception as exc:
        output({"error": f"Failed to read package.xml: {exc}"})


def cmd_pkg_create(args):
    """Create a new ROS 2 package scaffold via 'ros2 pkg create'.

    Delegates to the ros2 CLI so the generated CMakeLists.txt / setup.py
    always matches the installed ROS 2 distro templates.  No graph required.
    """
    cmd_parts = ["ros2", "pkg", "create", args.package_name]

    if args.build_type:
        cmd_parts += ["--build-type", args.build_type]
    if args.dependencies:
        cmd_parts += ["--dependencies"] + args.dependencies
    if args.destination_directory:
        cmd_parts += ["--destination-directory", args.destination_directory]
    if args.license:
        cmd_parts += ["--license", args.license]
    if args.maintainer_name:
        cmd_parts += ["--maintainer-name", args.maintainer_name]
    if args.maintainer_email:
        cmd_parts += ["--maintainer-email", args.maintainer_email]
    if args.description:
        cmd_parts += ["--description", args.description]
    if getattr(args, 'node_name', None):
        cmd_parts += ["--node-name", args.node_name]
    if getattr(args, 'library_name', None):
        cmd_parts += ["--library-name", args.library_name]

    try:
        proc = subprocess.run(
            cmd_parts,
            capture_output=True, text=True, timeout=60,
        )
    except FileNotFoundError:
        output({"error": "ros2 command not found — is ROS 2 sourced?",
                "command": " ".join(cmd_parts)})
        return
    except subprocess.TimeoutExpired:
        output({"error": "pkg create timed out after 60 seconds",
                "command": " ".join(cmd_parts)})
        return
    except Exception as exc:
        output({"error": str(exc)})
        return

    if proc.returncode != 0:
        output({
            "error": (proc.stderr.strip() or proc.stdout.strip()
                      or "pkg create failed with no error message"),
            "command": " ".join(cmd_parts),
        })
        return

    destination = os.path.abspath(args.destination_directory or os.getcwd())
    output({
        "success": True,
        "package": args.package_name,
        "build_type": args.build_type or "ament_cmake",
        "dependencies": args.dependencies or [],
        "destination": destination,
        "package_path": os.path.join(destination, args.package_name),
        "command": " ".join(cmd_parts),
        "output": proc.stdout.strip(),
    })


if __name__ == "__main__":
    import sys
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

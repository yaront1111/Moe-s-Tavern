#!/usr/bin/env python3
"""ROS 2 robot profile commands.

Builds and queries a persistent per-robot profile JSON that captures
packages, launch files, topics, safety limits, and
robot type — so every agent session can load the profile instead of
re-discovering from scratch.

Scan strategy (static-first):
  1. Walk the ROS 2 workspace src/ tree  →  package.xml, launch files,
     URDF/xacro, YAML param files, source code
  2. Query ament index                   →  all installed packages + prefixes
  3. Inspect /opt/ros/<distro>/          →  global packages (optional)
  4. Live graph fallback                 →  only if static gaps remain and
                                            --allow-live is passed

Output: .profiles/robot_profile.json next to this file's parent directory.
"""

import json
import math
import os
import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional

from ros2_utils import output


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCHEMA_VERSION = 1

_SCRIPT_DIR = pathlib.Path(__file__).parent
_PROFILES_DIR = (_SCRIPT_DIR / ".." / ".profiles").resolve()

# Workspace discovery candidates (in priority order).
_WS_CANDIDATES = [
    os.environ.get("ROS2_LOCAL_WS"),
    "~/ros2_ws",
    "~/ws",
    "~/colcon_ws",
    "~/dev_ws",
    "~/robot_ws",
    "~/workspace",
    "~/ros2",
]

# Velocity-related YAML keys we scan for safety limits.
_VEL_KEYS = {
    "max_vel_x", "max_vel_y", "max_vel_theta",
    "max_speed_xy", "max_rotation_speed",
    "max_linear_velocity", "max_angular_velocity",
    "translational_speed_limit", "rotational_speed_limit",
    "vel_limit", "linear_vel_limit", "angular_vel_limit",
    "linear", "angular",  # under [limits] or [safety]
}

# Nav2 action server name fragments.
_NAV2_FRAGMENTS = {
    "navigate_to_pose", "navigate_through_poses",
    "follow_path", "compute_path", "spin", "backup",
}

# ---------------------------------------------------------------------------
# Sensor hints (package names, topic fragments, source keywords).
# These are open-ended — add new entries as new hardware appears.
# ---------------------------------------------------------------------------

_LIDAR_HINTS = {
    "rplidar", "sllidar", "urg", "velodyne", "hokuyo",
    "laser_scan", "scan", "lidar", "pointcloud", "ouster",
    "livox", "hesai", "robosense",
}
_CAMERA_HINTS = {
    "camera", "realsense", "zed", "oak", "image_raw",
    "depth_image", "rgb", "color", "basler", "flir",
    "v4l2", "usb_cam", "opencv",
}
_IMU_HINTS = {"imu", "ahrs", "mpu", "bno", "vectornav", "xsens", "microstrain"}

# ---------------------------------------------------------------------------
# Robot-type hints — each set covers package names, topic fragments, and
# source-code keywords.  They are intentionally broad; detection is additive
# so an unrecognised platform still falls through gracefully to "unknown".
# ---------------------------------------------------------------------------

# Arm / manipulator (any DOF, any make).
_ARM_HINTS = {
    "arm", "gripper", "manipulator", "moveit", "joint_trajectory",
    "ur3", "ur5", "ur10", "panda", "kuka", "fanuc", "yaskawa",
    "abb", "kinova", "xarm", "hebi", "dynamixel",
    # NOTE: "servo" intentionally omitted — servo motors are used in mobile
    # bases, pan-tilt mechanisms, and legged robots; not specific to arms.
}

# Ground / wheeled mobile base.
_MOBILE_HINTS = {
    "diff_drive", "cmd_vel", "mecanum", "omni", "ackermann",
    "turtlebot", "husky", "jackal", "ridgeback", "summit",
    "roomba", "create3", "base_controller",
}

# Aerial / UAV / drone.
_AERIAL_HINTS = {
    "drone", "uav", "quadrotor", "multirotor", "hexarotor",
    "mavros", "px4", "ardupilot", "betaflight", "ardrone",
    "parrot", "dji", "rotors", "hector_quadrotor",
    "altitude", "takeoff", "land", "thrust",
}

# Legged robots (quadruped, hexapod, biped walkers that aren't full humanoids).
_LEGGED_HINTS = {
    "legged", "quadruped", "hexapod", "biped",
    "spot", "go1", "go2", "go3", "b1", "b2", "unitree", "anymal",
    "cheetah", "cassie", "hyq", "aliengo", "a1", "mini_cheetah",
    "leg_controller", "stance", "swing", "gait",
}

# Humanoid robots — specific platform names and ZMP only.
# Do NOT add generic locomotion words ("walking", "balance") — they appear in
# any robotics codebase and cause false positives on non-humanoid platforms.
_HUMANOID_HINTS = {
    "humanoid",
    "nao", "pepper", "romeo", "atlas", "valkyrie",
    "talos", "icub", "darwin", "op2", "op3", "thormang",
    "zmp",  # Zero Moment Point — specific to humanoid stability algorithms
}

# Pan-tilt / gimbal — supplementary feature, not a primary robot type.
_PANTILT_HINTS = {
    "pantilt", "pan_tilt", "ptz", "gimbal",
    "pan_controller", "tilt_controller",
}

# All valid primary robot type values.
_VALID_ROBOT_TYPES = frozenset({
    "humanoid", "legged", "aerial", "underwater", "surface_vessel",
    "mobile_manipulator", "arm", "mobile_base", "unknown",
})

# Underwater ROV / AUV.
_UNDERWATER_HINTS = {
    "underwater", "uuv", "rov", "auv", "bluerov", "bluerobotics",
    "thruster", "dvl", "depth_sensor", "pressure",
    "waterlinked", "bar30", "ping",
}

# Surface vessels (USV / ASV / boat).
_SURFACE_VESSEL_HINTS = {
    "usv", "asv", "boat", "vessel", "marine", "nauticus",
    "wam_v", "navquad", "rudder", "propeller", "watercraft",
}


# ---------------------------------------------------------------------------
# Workspace discovery
# ---------------------------------------------------------------------------

def _discover_workspace(user_path=None):
    """Return the absolute path of the best candidate ROS 2 workspace.

    Search order:
      1. user_path argument
      2. ROS2_LOCAL_WS env var
      3. Common paths: ~/ros2_ws, ~/ws, ~/colcon_ws, ~/dev_ws, ~/robot_ws, ~/workspace, ~/ros2

    A directory qualifies if it contains a ``src/`` sub-directory (indicating
    a colcon workspace).  ``install/`` is not required — the workspace may not
    yet be built, and static analysis only needs the sources.

    Returns:
        (path_str, status) where status is one of
          "user_provided" | "found" | "not_found"
    """
    def _is_ws(p):
        return p.is_dir() and (p / "src").is_dir()

    if user_path:
        p = pathlib.Path(user_path).expanduser().resolve()
        if _is_ws(p):
            return str(p), "user_provided"
        # Still honour it even without src/ — user knows best.
        if p.is_dir():
            return str(p), "user_provided"

    candidates = [c for c in _WS_CANDIDATES if c]
    for raw in candidates:
        p = pathlib.Path(raw).expanduser().resolve()
        if _is_ws(p):
            return str(p), "found"

    return None, "not_found"


# ---------------------------------------------------------------------------
# Static filesystem scanning
# ---------------------------------------------------------------------------

def _scan_packages_from_ament():
    """Return {name: prefix_path} for every ament-indexed package."""
    try:
        from ament_index_python.packages import get_packages_with_prefixes
        return dict(get_packages_with_prefixes())
    except ImportError:
        return {}
    except Exception:
        return {}


def _parse_pkg_filter(pkg_filter):
    """Normalise *pkg_filter* to a list of lower-case pattern strings.

    Accepts:
    - ``None`` / empty string  → returns ``[]`` (no filtering)
    - A comma-separated string → splits on commas and strips whitespace
    - A list of strings        → strips and lower-cases each entry

    Example::

        _parse_pkg_filter("lekiwi, soarm")  # → ["lekiwi", "soarm"]
        _parse_pkg_filter(["lekiwi"])       # → ["lekiwi"]
        _parse_pkg_filter(None)             # → []
    """
    if not pkg_filter:
        return []
    if isinstance(pkg_filter, str):
        return [p.strip().lower() for p in pkg_filter.split(",") if p.strip()]
    return [p.strip().lower() for p in pkg_filter if p.strip()]


def _pkg_matches_filter(pkg_name, pkg_path, patterns):
    """Return True if *pkg_name* or *pkg_path* contains any of *patterns*.

    Matching is case-insensitive substring matching so ``"lekiwi"`` matches
    ``lekiwi_bringup``, ``lekiwi_control``, and any path containing
    ``lekiwi_ros2/lekiwi_control``.
    """
    name_lower = pkg_name.lower()
    path_lower = pkg_path.lower()
    return any(p in name_lower or p in path_lower for p in patterns)


def _walk_workspace_src(ws_path, pkg_filter=None):
    """Walk ``<ws>/src`` and collect package information.

    *pkg_filter* is a comma-separated string or list of patterns used to
    restrict which packages are treated as **primary**.  The full ``src/``
    tree is always indexed; packages whose name **or** path does not contain
    any pattern are skipped as primary candidates but may still be included
    as **dependencies** of primary packages (see below).

    **Two-role model:**

    - ``"primary"`` — packages matched by *pkg_filter* (or all packages when
      no filter is given).  Fully scanned: URDFs, launch files, YAML configs,
      and source files.
    - ``"dependency"`` — workspace-local packages that are declared as
      ``<depend>`` / ``<exec_depend>`` by any primary package but do not
      themselves match the filter.  Only YAML configs and source files are
      collected; their standalone launch files and URDFs (which exist for
      testing/examples of that driver, not for the target robot) are excluded.

    Dependency resolution is **one level deep**: deps-of-deps are not
    expanded, avoiding pulling in the entire ROS ecosystem.

    When *pkg_filter* is ``None`` or empty, all packages are primary and the
    dependency role is never used (legacy full-workspace behaviour).

    Returns::

        {
          "packages":            [...],  # primary + dependency package dicts
          "pkg_filter":          [...],  # normalised filter patterns (may be [])
          "matched_dirs":        [...],  # unique parent dirs of primary packages
          "primary_packages":    [...],  # names of primary packages
          "dependency_packages": [...],  # names of workspace-local dep packages
        }
    """
    patterns = _parse_pkg_filter(pkg_filter)
    src = pathlib.Path(ws_path) / "src"
    if not src.is_dir():
        return {
            "packages": [], "pkg_filter": patterns, "matched_dirs": [],
            "primary_packages": [], "dependency_packages": [],
        }

    # ------------------------------------------------------------------
    # Pass 1: index every package.xml in src/ → {pkg_name: pkg_dir_path}
    # ------------------------------------------------------------------
    ws_index: dict[str, pathlib.Path] = {}
    ws_info: dict[str, dict] = {}
    for pkg_xml in src.rglob("package.xml"):
        pkg_dir = pkg_xml.parent
        info = _parse_package_xml(pkg_xml)
        ws_index[info["name"]] = pkg_dir
        ws_info[info["name"]] = info

    # ------------------------------------------------------------------
    # Pass 2: determine primary packages
    # ------------------------------------------------------------------
    if patterns:
        primary_names = {
            name for name, pkg_dir in ws_index.items()
            if _pkg_matches_filter(name, str(pkg_dir), patterns)
        }
    else:
        primary_names = set(ws_index.keys())

    # ------------------------------------------------------------------
    # Pass 3: collect one-level workspace-local dependencies of primaries
    # ------------------------------------------------------------------
    dep_names: set = set()
    if patterns:  # only meaningful when a filter is active
        for pname in primary_names:
            for dep in ws_info[pname].get("deps", []):
                if dep in ws_index and dep not in primary_names:
                    dep_names.add(dep)

    # ------------------------------------------------------------------
    # Pass 4: collect file lists for each role
    # ------------------------------------------------------------------
    packages = []
    matched_dirs: set = set()

    def _collect_files(pkg_dir, role):
        """Return (launch_files, yaml_files, urdf_files, src_files) for a pkg dir."""
        # Launch files — primary only
        launch_files = []
        if role == "primary":
            for ext in ("*.launch.py", "*.launch.xml", "*.launch", "*.launch.yaml"):
                launch_files.extend(pkg_dir.rglob(ext))

        # YAML param files — both roles
        yaml_files = []
        for pattern in ("*.yaml", "*.yml"):
            for yf in pkg_dir.rglob(pattern):
                if "test" not in yf.parts and yf.name not in ("package.xml",):
                    yaml_files.append(yf)

        # URDF / xacro — primary only
        urdf_files = []
        if role == "primary":
            for pattern in ("*.urdf", "*.urdf.xacro", "*.xacro"):
                urdf_files.extend(pkg_dir.rglob(pattern))

        # Source files — both roles
        src_files = []
        for pattern in ("*.py", "*.cpp", "*.hpp"):
            for sf in pkg_dir.rglob(pattern):
                if "test" not in sf.parts:
                    src_files.append(str(sf))

        return (
            [str(f) for f in sorted(launch_files)],
            [str(f) for f in sorted(yaml_files)],
            [str(f) for f in sorted(urdf_files)],
            src_files,
        )

    for name in sorted(primary_names):
        pkg_dir = ws_index[name]
        info = dict(ws_info[name])
        info["path"] = str(pkg_dir)
        info["role"] = "primary"
        lf, yf, uf, sf = _collect_files(pkg_dir, "primary")
        info["launch_files"] = lf
        info["yaml_files"] = yf
        info["urdf_files"] = uf
        info["src_files"] = sf
        packages.append(info)
        matched_dirs.add(str(pkg_dir.parent))

    for name in sorted(dep_names):
        pkg_dir = ws_index[name]
        info = dict(ws_info[name])
        info["path"] = str(pkg_dir)
        info["role"] = "dependency"
        lf, yf, uf, sf = _collect_files(pkg_dir, "dependency")
        info["launch_files"] = lf   # always [] for deps
        info["yaml_files"] = yf
        info["urdf_files"] = uf     # always [] for deps
        info["src_files"] = sf
        packages.append(info)

    return {
        "packages": packages,
        "pkg_filter": patterns,
        "matched_dirs": sorted(matched_dirs),
        "primary_packages": sorted(primary_names),
        "dependency_packages": sorted(dep_names),
    }


def _parse_package_xml(path):
    """Extract name, version, and runtime deps from a package.xml file."""
    try:
        tree = ET.parse(str(path))
        root = tree.getroot()
        name = (root.findtext("name") or path.parent.name).strip()
        version = (root.findtext("version") or "").strip()
        # Runtime / build-exec dependencies only — these represent packages that
        # must be present when the robot actually runs, making them the relevant
        # set for profile scoping.
        dep_tags = {"depend", "exec_depend", "build_exec_depend"}
        deps = sorted({
            el.text.strip()
            for el in root
            if el.tag in dep_tags and el.text and el.text.strip()
        })
        return {"name": name, "version": version, "deps": deps}
    except Exception:
        return {"name": path.parent.name, "version": "", "deps": []}


# ---------------------------------------------------------------------------
# Launch file analysis
# ---------------------------------------------------------------------------


def _query_launch_args(launch_file, package=None, timeout=15):
    """Run ``ros2 launch --show-args`` and return a dict of {arg: default}.

    Returns {} on failure (file not executable, xacro expansion fails, etc.).
    """
    # Build the ros2 launch command.
    if package:
        cmd = ["ros2", "launch", package, pathlib.Path(launch_file).name, "--show-args"]
    else:
        cmd = ["ros2", "launch", str(launch_file), "--show-args"]

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
        )
        stdout = proc.stdout.strip()
        if not stdout or proc.returncode != 0:
            return {}
        return _parse_show_args_output(stdout)
    except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
        return {}


def _parse_show_args_output(text):
    """Parse the output of ``ros2 launch --show-args`` into a dict.

    The output looks like:
        Arguments (pass arguments as '<name>:=<value>'):
          'use_sim_time':
            default: 'False'
          'robot_description':
            (default: None)
    """
    result = {}
    current_key = None
    for line in text.splitlines():
        stripped = line.strip()
        # Match argument name lines: 'arg_name':
        m = re.match(r"^'([^']+)'\s*:", stripped)
        if m:
            current_key = m.group(1)
            result[current_key] = None
            continue
        # Match default value lines.
        if current_key:
            m2 = re.match(r"^(?:default|default:)\s*[:'\"]*([^'\"]*)['\"]?$", stripped, re.I)
            if m2:
                val = m2.group(1).strip()
                if val.lower() not in ("none", ""):
                    result[current_key] = val
                continue
    return result


# ---------------------------------------------------------------------------
# Launch include analysis — static parsing of sub-launch inclusion chains
# ---------------------------------------------------------------------------

def _parse_launch_includes(launch_path):
    """Return a list of sub-launch include records found in *launch_path*.

    Each record:
    {
        "source": "<str>",         # best-effort path/package description
        "package": "<str>|None",   # package name if determinable
        "file": "<str>|None",      # filename of the included launch file
        "args_forwarded": {        # arguments passed to the included file
            "<arg>": "<value>",    # literal string, or "$ref" for LaunchConfiguration('ref')
            ...
        }
    }

    Supports:
    - Python .launch.py files  (ast-based, best-effort)
    - XML    .launch.xml files (ElementTree)
    - YAML   .launch.yaml files (PyYAML, limited)
    """
    path = pathlib.Path(launch_path)
    if not path.exists():
        return []
    name = path.name.lower()
    if name.endswith(".launch.py"):
        return _parse_python_includes(path)
    if name.endswith((".launch.xml", ".launch")) or path.suffix == ".xml":
        return _parse_xml_includes(path)
    if name.endswith((".launch.yaml", ".launch.yml")):
        return _parse_yaml_includes(path)
    return []


# ---- Python (.launch.py) --------------------------------------------------

def _ast_call_name(node):
    """Return the bare function name from an ast.Call node."""
    import ast as _ast
    if isinstance(node.func, _ast.Name):
        return node.func.id
    if isinstance(node.func, _ast.Attribute):
        return node.func.attr
    return ""


def _ast_to_str(node):
    """Convert an AST node to a concise human-readable string.

    Conventions:
    - String/int constant       → the literal value
    - LaunchConfiguration('x') → "$x"
    - get_package_share_directory('p') / FindPackageShare('p') → "pkg:p"
    - PathJoinSubstitution([...]) / os.path.join(...) → joined parts
    - Variable name reference   → "$varname"
    - Anything else             → "<expr>"
    """
    import ast as _ast

    if node is None:
        return None
    if isinstance(node, _ast.Constant):
        return str(node.value)
    if isinstance(node, _ast.Name):
        return f"${node.id}"
    if isinstance(node, _ast.Call):
        fn = _ast_call_name(node)
        if fn == "LaunchConfiguration" and node.args:
            inner = _ast_to_str(node.args[0])
            return f"${inner}" if inner else "$?"
        if fn in ("get_package_share_directory", "FindPackageShare") and node.args:
            pkg = _ast_to_str(node.args[0])
            return f"pkg:{pkg}" if pkg else "pkg:?"
        if fn in ("PathJoinSubstitution", "JoinPathSegments") and node.args:
            arg0 = node.args[0]
            if isinstance(arg0, (_ast.List, _ast.Tuple)):
                parts = [_ast_to_str(e) for e in arg0.elts]
                return "/".join(p for p in parts if p)
        if fn in ("os.path.join", "join"):
            parts = [_ast_to_str(a) for a in node.args]
            return "/".join(p for p in parts if p)
        if fn == "PythonLaunchDescriptionSource" and node.args:
            return _ast_to_str(node.args[0])
        if fn == "AnyLaunchDescriptionSource" and node.args:
            return _ast_to_str(node.args[0])
        # Generic: show the function name so the reader understands context.
        return f"{fn}(...)"
    if isinstance(node, (_ast.List, _ast.Tuple)):
        parts = [_ast_to_str(e) for e in node.elts]
        return "/".join(p for p in parts if p)
    if isinstance(node, _ast.BinOp):
        import ast as _ast2
        if isinstance(node.op, _ast2.Add):
            left = _ast_to_str(node.left)
            right = _ast_to_str(node.right)
            return f"{left}{right}"
    if isinstance(node, _ast.Attribute):
        owner = _ast_to_str(node.value)
        return f"{owner}.{node.attr}"
    if isinstance(node, _ast.JoinedStr):        # f-string — too dynamic to resolve
        return "<f-string>"
    return "<expr>"


def _ast_extract_forwarded_args(node):
    """Extract {arg_name: value_str} from a launch_arguments AST node.

    Accepts all three forms used in ROS 2 Python launch files:
    - Dict literal:                  {"key": value, ...}
    - Dict.items() call:             {"key": value, ...}.items()
    - List/tuple of (name, value):   [("key", value), ...]
    """
    import ast as _ast
    # Unwrap {}.items() — very common in ROS 2 launch files.
    if (isinstance(node, _ast.Call)
            and isinstance(node.func, _ast.Attribute)
            and node.func.attr == "items"
            and isinstance(node.func.value, _ast.Dict)):
        node = node.func.value

    result = {}
    if isinstance(node, _ast.Dict):
        for k, v in zip(node.keys, node.values):
            key = _ast_to_str(k)
            val = _ast_to_str(v)
            if key and not key.startswith("$"):
                result[key] = val
    elif isinstance(node, (_ast.List, _ast.Tuple)):
        for elt in node.elts:
            if isinstance(elt, (_ast.Tuple, _ast.List)) and len(elt.elts) == 2:
                key = _ast_to_str(elt.elts[0])
                val = _ast_to_str(elt.elts[1])
                if key and not key.startswith("$"):
                    result[key] = val
    return result


def _parse_python_includes(path):
    """Parse a Python launch file and return include records (ast-based)."""
    import ast as _ast
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        tree = _ast.parse(text, filename=str(path))
    except Exception:
        return []

    includes = []
    for node in _ast.walk(tree):
        if not isinstance(node, _ast.Call):
            continue
        if _ast_call_name(node) != "IncludeLaunchDescription":
            continue

        # ── source (first positional arg or 'launch_description_source' kw) ──
        source_node = None
        if node.args:
            source_node = node.args[0]
        else:
            for kw in node.keywords:
                if kw.arg in ("launch_description_source", None):
                    source_node = kw.value
                    break
        source_str = _ast_to_str(source_node) if source_node else None

        # ── extract package and filename from source_str ──
        pkg, fname = _decompose_source(source_str)

        # ── launch_arguments ──
        forwarded = {}
        for kw in node.keywords:
            if kw.arg == "launch_arguments":
                forwarded = _ast_extract_forwarded_args(kw.value)
                break

        includes.append({
            "source": source_str,
            "package": pkg,
            "file": fname,
            "args_forwarded": forwarded,
        })

    return includes


def _decompose_source(source_str):
    """Split a source string like 'pkg:nav2_bringup/launch/bringup_launch.py'
    into (package, filename).  Returns (None, None) when not determinable."""
    if not source_str:
        return None, None
    # "pkg:nav2_bringup/launch/bringup_launch.py"
    m = re.match(r"pkg:([^/]+)/(.+)", source_str)
    if m:
        pkg = m.group(1)
        rest = m.group(2)
        fname = pathlib.Path(rest).name
        return pkg, fname
    # Plain path — try to extract the filename
    if "/" in source_str or "\\" in source_str:
        fname = pathlib.Path(source_str).name
        return None, fname if fname else None
    return None, None


# ---- XML (.launch.xml / .launch) ------------------------------------------

def _parse_xml_includes(path):
    """Parse an XML launch file and return include records."""
    try:
        tree = ET.parse(str(path))
        root = tree.getroot()
    except Exception:
        return []

    includes = []
    for inc in root.iter("include"):
        source = inc.get("file", "") or inc.get("pkg", "")
        # $(find pkg)/launch/file.py  or  $(pkg-path pkg)/...
        pkg, fname = None, None
        m = re.search(r"\$\(find\s+([^)]+)\)", source)
        if m:
            pkg = m.group(1)
            fname = pathlib.Path(source.split(")")[-1]).name or None
        else:
            fname = pathlib.Path(source).name or None

        forwarded = {}
        for arg in inc.findall("arg"):
            name = arg.get("name", "")
            value = arg.get("value") or arg.get("default")
            if name:
                # Convert ROS XML substitution $(arg x) → $x
                if value:
                    value = re.sub(r"\$\(arg\s+([^)]+)\)", r"$\1", value)
                forwarded[name] = value

        includes.append({
            "source": source or None,
            "package": pkg,
            "file": fname,
            "args_forwarded": forwarded,
        })

    return includes


# ---- YAML (.launch.yaml) --------------------------------------------------

def _parse_yaml_includes(path):
    """Parse a YAML launch file and return include records (limited support)."""
    try:
        import yaml
        with open(path, encoding="utf-8", errors="replace") as fh:
            data = yaml.safe_load(fh)
    except Exception:
        return []

    if not isinstance(data, list):
        return []

    includes = []
    for item in data:
        if not isinstance(item, dict) or "include" not in item:
            continue
        inc = item["include"]
        if not isinstance(inc, dict):
            continue
        source = inc.pop("file", None)
        pkg, fname = _decompose_source(source)
        includes.append({
            "source": source,
            "package": pkg,
            "file": fname,
            "args_forwarded": {k: str(v) for k, v in inc.items()},
        })

    return includes


# ---------------------------------------------------------------------------
# YAML safety limit extraction
# ---------------------------------------------------------------------------

def _extract_limits_from_yaml(yaml_path):
    """Return ``(linear_x, linear_y, angular_z)`` found in a param YAML file.

    Each element is ``None`` when the axis limit is not found.
    """
    try:
        import yaml  # PyYAML — available in ROS 2 environments
    except ImportError:
        return _extract_limits_from_yaml_regex(yaml_path)

    try:
        with open(yaml_path, encoding="utf-8", errors="replace") as fh:
            data = yaml.safe_load(fh)
        if not isinstance(data, dict):
            return None, None, None
        return _search_limits_in_dict(data)
    except Exception:
        return None, None, None


def _search_limits_in_dict(d, depth=0):
    """Recursively search a parsed YAML dict for per-axis velocity limits.

    Returns ``(linear_x, linear_y, angular_z)`` — any element may be ``None``
    when the corresponding limit is not found in this subtree.

    Recognised formats
    ------------------
    * **Flat keys** (Nav2 DWB / TEB / MPPI planner, teleop flat form)::

        max_vel_x: 0.5
        max_vel_y: 0.3
        max_vel_theta: 1.0
        scale_linear: 0.5        # teleop_twist_joy flat
        scale_angular: 1.0

    * **ros2_control DiffDriveController / AckermannSteering** nested::

        linear:
          x:
            max_velocity: 0.5
        angular:
          z:
            max_velocity: 1.0

    * **teleop_twist_joy v2** nested scale::

        scale_linear:
          x: 0.5
          y: 0.3
        scale_angular:
          yaw: 1.0

    * **velocity_smoother** list form::

        max_velocity: [0.5, 0.0, 1.0]   # [lin_x, lin_y, ang_z]
    """
    if depth > 8 or not isinstance(d, dict):
        return None, None, None
    lin_x, lin_y, ang_z = None, None, None

    def _upd(current, candidate):
        """Keep the most restrictive (smallest) non-None value."""
        if candidate is None or candidate <= 0:
            return current
        return float(candidate) if current is None else min(current, float(candidate))

    for key, val in d.items():
        kl = key.lower()

        # --- Direct numeric value ---
        if isinstance(val, (int, float)) and val > 0:
            if kl in _LINEAR_X_KEYS:
                lin_x = _upd(lin_x, val)
            elif kl in _LINEAR_Y_KEYS:
                lin_y = _upd(lin_y, val)
            elif kl in _ANGULAR_Z_KEYS:
                ang_z = _upd(ang_z, val)

        # --- List form: max_velocity: [lin_x, lin_y, ang_z] ---
        elif isinstance(val, list) and ("max_velocity" in kl or "max_vel" in kl):
            if len(val) >= 1:
                lin_x = _upd(lin_x, val[0] if isinstance(val[0], (int, float)) else None)
            if len(val) >= 2:
                lin_y = _upd(lin_y, val[1] if isinstance(val[1], (int, float)) else None)
            if len(val) >= 3:
                ang_z = _upd(ang_z, val[2] if isinstance(val[2], (int, float)) else None)

        # --- Nested dict blocks ---
        elif isinstance(val, dict):
            if kl == "linear":
                # ros2_control: linear: {x: {max_velocity: N}, y: {max_velocity: N}}
                x_block = val.get("x", {})
                if isinstance(x_block, dict):
                    mv = x_block.get("max_velocity") or x_block.get("max_vel")
                    lin_x = _upd(lin_x, mv)
                y_block = val.get("y", {})
                if isinstance(y_block, dict):
                    mv = y_block.get("max_velocity") or y_block.get("max_vel")
                    lin_y = _upd(lin_y, mv)
                # short form: linear: {max_velocity: N}
                lin_x = _upd(lin_x, val.get("max_velocity") or val.get("max_vel"))

            elif kl == "angular":
                # ros2_control: angular: {z: {max_velocity: N}}
                z_block = val.get("z", {})
                if isinstance(z_block, dict):
                    mv = z_block.get("max_velocity") or z_block.get("max_vel")
                    ang_z = _upd(ang_z, mv)
                # short form: angular: {max_velocity: N}
                ang_z = _upd(ang_z, val.get("max_velocity") or val.get("max_vel"))

            elif kl == "scale_linear":
                # teleop_twist_joy v2: scale_linear: {x: N, y: N}
                if "x" in val:
                    lin_x = _upd(lin_x, val["x"] if isinstance(val["x"], (int, float)) else None)
                if "y" in val:
                    lin_y = _upd(lin_y, val["y"] if isinstance(val["y"], (int, float)) else None)

            elif kl in ("scale_angular", "scale_angular_yaw"):
                # teleop_twist_joy v2: scale_angular: {yaw: N} or scale_angular: {z: N}
                for ak in ("yaw", "z"):
                    if ak in val:
                        ang_z = _upd(ang_z, val[ak] if isinstance(val[ak], (int, float)) else None)

            else:
                sub_x, sub_y, sub_z = _search_limits_in_dict(val, depth + 1)
                lin_x = _upd(lin_x, sub_x)
                lin_y = _upd(lin_y, sub_y)
                ang_z = _upd(ang_z, sub_z)

    return lin_x, lin_y, ang_z


def _extract_limits_from_yaml_regex(yaml_path):
    """Fallback: line-by-line regex scan when PyYAML is unavailable.

    Returns ``(linear_x, linear_y, angular_z)`` — any element may be ``None``.
    """
    _LIN_X_PATS = [re.compile(r"(?:^|\s)" + re.escape(k) + r"\s*:\s*([\d.]+)")
                   for k in _LINEAR_X_KEYS]
    _LIN_Y_PATS = [re.compile(r"(?:^|\s)" + re.escape(k) + r"\s*:\s*([\d.]+)")
                   for k in _LINEAR_Y_KEYS]
    _ANG_Z_PATS = [re.compile(r"(?:^|\s)" + re.escape(k) + r"\s*:\s*([\d.]+)")
                   for k in _ANGULAR_Z_KEYS]
    lin_x, lin_y, ang_z = None, None, None
    try:
        text = pathlib.Path(yaml_path).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None, None, None

    for line in text.splitlines():
        stripped = line.strip()
        for pat in _LIN_X_PATS:
            m = pat.search(stripped)
            if m:
                v = float(m.group(1))
                if v > 0 and (lin_x is None or v < lin_x):
                    lin_x = v
        for pat in _LIN_Y_PATS:
            m = pat.search(stripped)
            if m:
                v = float(m.group(1))
                if v > 0 and (lin_y is None or v < lin_y):
                    lin_y = v
        for pat in _ANG_Z_PATS:
            m = pat.search(stripped)
            if m:
                v = float(m.group(1))
                if v > 0 and (ang_z is None or v < ang_z):
                    ang_z = v
    return lin_x, lin_y, ang_z


# ---------------------------------------------------------------------------
# YAML joint position limit extraction (ros2_control format)
# ---------------------------------------------------------------------------

def _extract_joint_limits_from_yaml(yaml_path):
    """Return {joint_name: {min_position, max_position, has_position_limits}} from YAML.

    Parses the standard ros2_control joint_limits block::

        joint_limits:
          pan_joint:
            has_position_limits: true
            min_position: -1.5708
            max_position:  1.5708
    """
    result = {}
    try:
        import yaml
        with open(yaml_path, encoding="utf-8", errors="replace") as fh:
            data = yaml.safe_load(fh)
        if not isinstance(data, dict):
            return result
        # joint_limits may be at top level or nested under ros__parameters
        def _find_joint_limits(d, depth=0):
            if depth > 4 or not isinstance(d, dict):
                return None
            if "joint_limits" in d and isinstance(d["joint_limits"], dict):
                return d["joint_limits"]
            for v in d.values():
                found = _find_joint_limits(v, depth + 1)
                if found is not None:
                    return found
            return None
        jl_block = _find_joint_limits(data)
        if not jl_block:
            return result
        for jname, jdata in jl_block.items():
            if not isinstance(jdata, dict):
                continue
            entry = {}
            for key in ("min_position", "max_position", "has_position_limits",
                        "home_position", "initial_position"):
                if key in jdata:
                    entry[key] = jdata[key]
            if entry:
                result[jname] = entry
    except Exception:
        pass
    return result


# ---------------------------------------------------------------------------
# URDF joint limit extraction
# ---------------------------------------------------------------------------

def _extract_joint_limits_from_urdf(urdf_path):
    """Parse a URDF file and return {joint_name: {velocity, effort, lower, upper, type}}."""
    limits = {}
    try:
        tree = ET.parse(str(urdf_path))
        root = tree.getroot()
        for joint in root.findall(".//joint"):
            name = joint.get("name", "")
            j_type = joint.get("type", "fixed")
            if j_type == "fixed":
                continue
            limit_el = joint.find("limit")
            if limit_el is not None:
                def _f(attr):
                    v = limit_el.get(attr)
                    try:
                        return float(v) if v is not None else None
                    except ValueError:
                        return None
                limits[name] = {
                    "velocity": _f("velocity"),
                    "effort":   _f("effort"),
                    "lower":    _f("lower"),
                    "upper":    _f("upper"),
                    "type":     j_type,
                }
    except Exception:
        pass
    return limits


def _extract_joint_params_from_urdf(urdf_path):
    """Return {joint_name: {param_key: value}} from <ros2_control><joint><param> blocks.

    Extracts hardware-level per-joint parameters — position limits, homing offsets,
    center steps, and similar driver-specific values — from the ``<ros2_control>``
    section of a URDF or compiled xacro.  Values containing ``${`` are skipped.
    """
    _JOINT_PARAM_KEYS = {
        "min_position", "max_position",
        "position_center_steps", "home_position", "homing_offset",
        "min_position_steps", "max_position_steps",
        "center_steps", "offset_steps", "initial_position",
        "zero_position", "neutral_position",
    }
    result = {}
    try:
        tree = ET.parse(str(urdf_path))
        root = tree.getroot()
        for rc in root.iter("ros2_control"):
            for joint_el in rc.findall("joint"):
                jname = joint_el.get("name", "").strip()
                if not jname:
                    continue
                for param in joint_el.findall("param"):
                    key = (param.get("name") or "").lower().strip()
                    if key not in _JOINT_PARAM_KEYS:
                        continue
                    text = (param.text or "").strip()
                    if not text or "${" in text:
                        continue
                    try:
                        val = float(text)
                    except ValueError:
                        val = text
                    result.setdefault(jname, {})[key] = val
    except Exception:
        pass
    return result


def _extract_safety_velocity_from_urdf(urdf_path):
    """Return (linear_max, angular_max) from URDF safety_controller elements.

    These are usually on the wheel joints and encode the actual velocity ceiling.
    """
    linear, angular = None, None
    try:
        tree = ET.parse(str(urdf_path))
        root = tree.getroot()
        for sc in root.findall(".//safety_controller"):
            vel_limit = sc.get("k_velocity") or sc.get("velocity")
            if vel_limit:
                try:
                    v = float(vel_limit)
                    if linear is None:
                        linear = v
                except ValueError:
                    pass
    except Exception:
        pass
    return linear, angular


def _resolve_joint_limits(joint_limits_by_model: dict) -> dict:
    """Return a flat {joint_name: {fields}} dict from per-model joint data.

    Merges all URDF-sourced models into one entry per joint, then overlays the
    YAML joint_limits block (stored under ``"_yaml"``).  YAML values override
    URDF ``<limit>`` attributes for any field present in both; hardware
    parameters that only appear in URDF (``position_center_steps``,
    ``homing_offset``, etc.) are always kept.  Joint names that still contain
    unresolved xacro substitutions (``${…}``) are dropped.
    """
    yaml_joints: dict = joint_limits_by_model.get("_yaml", {})
    merged: dict = {}

    for model, joints in joint_limits_by_model.items():
        if model == "_yaml":
            continue
        for jname, fields in joints.items():
            if "${" in jname:
                continue
            merged.setdefault(jname, {}).update(fields)

    for jname, fields in yaml_joints.items():
        if "${" in jname:
            continue
        entry = merged.setdefault(jname, {})
        entry.update(fields)
        if "min_position" in fields:
            entry["lower"] = fields["min_position"]
        if "max_position" in fields:
            entry["upper"] = fields["max_position"]

    for fields in merged.values():
        if "min_position" not in fields and fields.get("lower") is not None:
            fields["min_position"] = fields["lower"]
        if "max_position" not in fields and fields.get("upper") is not None:
            fields["max_position"] = fields["upper"]

    return merged


# ---------------------------------------------------------------------------
# URDF / xacro velocity param extraction
# ---------------------------------------------------------------------------

def _extract_limits_from_urdf_params(urdf_path):
    """Return ``(linear_x, linear_y, angular_z)`` from ``<param>`` elements in a URDF/xacro.

    Scans every ``<param name="KEY">VALUE</param>`` element whose name matches
    ``_VEL_KEYS``.  Values containing ``${`` are skipped — unresolved xacro
    substitutions that cannot be evaluated without running xacro.  The smallest
    positive value per axis wins (same "most restrictive" logic as YAML).

    Works on plain ``.urdf`` files and on ``.xacro`` / ``.urdf.xacro`` files
    whose ``<param>`` values are numeric literals (compiled output or concrete values).
    """
    lin_x, lin_y, ang_z = None, None, None

    def _upd(cur, val):
        if val is None or val <= 0:
            return cur
        return float(val) if cur is None else min(cur, float(val))

    try:
        tree = ET.parse(str(urdf_path))
        root = tree.getroot()
        for param in root.iter("param"):
            name = (param.get("name") or "").lower().strip()
            if name not in _VEL_KEYS:
                continue
            text = (param.text or "").strip()
            if not text or "${" in text:
                continue
            try:
                v = float(text)
            except ValueError:
                continue
            if any(k in name for k in ("vel_x", "vel_lin", "linear", "translational", "max_vel_x", "max_speed")):
                lin_x = _upd(lin_x, v)
            elif any(k in name for k in ("vel_y", "vel_lat")):
                lin_y = _upd(lin_y, v)
            elif any(k in name for k in ("vel_theta", "vel_ang", "angular", "rotational", "max_vel_theta")):
                ang_z = _upd(ang_z, v)
            elif name in ("max_velocity", "max_vel"):
                lin_x = _upd(lin_x, v)
    except Exception:
        pass

    return lin_x, lin_y, ang_z


# ---------------------------------------------------------------------------
# URDF robot name helper
# ---------------------------------------------------------------------------

def _get_urdf_robot_name(urdf_path):
    """Return the ``<robot name="…">`` attribute, or the file stem as fallback.

    Used to group joint limits by the URDF model they came from so that
    test/example URDFs in the workspace do not pollute the main robot's joints.
    """
    try:
        tree = ET.parse(str(urdf_path))
        name = tree.getroot().get("name", "").strip()
        if name:
            return name
    except Exception:
        pass
    # Strip known URDF suffixes (.urdf, .urdf.xacro, .xacro) from the filename.
    stem = pathlib.Path(urdf_path).stem
    for suffix in (".urdf", ".xacro"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
    return stem or "unknown"


# ---------------------------------------------------------------------------
# Velocity-limit key sets used by YAML extraction
# ---------------------------------------------------------------------------

# Keys whose value is a linear-x velocity limit (or a combined linear limit
# when linear-y is not separately specified).
_LINEAR_X_KEYS = frozenset({
    # Nav2 planner / controller params
    "max_vel_x", "max_linear_velocity", "max_speed_xy",
    "translational_speed_limit", "linear_vel_limit",
    "max_linear", "linear_max",
    # teleop_twist_joy scale params (flat form)
    "scale_linear", "scale_linear_x", "linear_scale", "linear_scale_x",
})

# Keys whose value is a linear-y velocity limit (holonomic robots).
_LINEAR_Y_KEYS = frozenset({
    "max_vel_y",
    "scale_linear_y", "linear_scale_y",
})

# Keys whose value is an angular-z velocity limit.
_ANGULAR_Z_KEYS = frozenset({
    # Nav2 planner / controller params
    "max_vel_theta", "max_angular_velocity", "max_rotation_speed",
    "rotational_speed_limit", "angular_vel_limit",
    "max_angular", "angular_max",
    # teleop_twist_joy scale params (flat form)
    "scale_angular", "scale_angular_z", "scale_angular_yaw",
    "angular_scale", "angular_scale_z",
})

# Backward-compat aliases used elsewhere in the module.
_LINEAR_KEYS = _LINEAR_X_KEYS
_ANGULAR_KEYS = _ANGULAR_Z_KEYS


# ---------------------------------------------------------------------------
# YAML helpers used by the new extractors
# ---------------------------------------------------------------------------

def _load_yaml(path):
    """Load a YAML file and return the parsed object, or None on any failure."""
    try:
        import yaml
        with open(path, encoding="utf-8", errors="replace") as fh:
            return yaml.safe_load(fh)
    except Exception:
        return None


def _deep_get(d, *keys):
    """Safely traverse a nested dict; return None if any key is missing."""
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def _walk_dict_items(d, max_depth=8, _depth=0):
    """Yield (key, value) for every key at every nesting level of *d*."""
    if _depth > max_depth or not isinstance(d, dict):
        return
    for k, v in d.items():
        yield k, v
        if isinstance(v, dict):
            yield from _walk_dict_items(v, max_depth, _depth + 1)
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    yield from _walk_dict_items(item, max_depth, _depth + 1)


def _find_node_block(d, node_names, depth=0):
    """Return the ros__parameters (or raw) dict for any node name in *node_names*."""
    if not isinstance(d, dict) or depth > 5:
        return None
    for k, v in d.items():
        if k in node_names and isinstance(v, dict):
            return v.get("ros__parameters") or v
        if isinstance(v, dict):
            found = _find_node_block(v, node_names, depth + 1)
            if found is not None:
                return found
    return None


# ---------------------------------------------------------------------------
# Drive type + ros2_control config
# ---------------------------------------------------------------------------

# Maps substrings of ros2_control plugin type strings to drive_type values.
_DRIVE_TYPE_MAP = [
    ("OmniWheelDriveController",    "holonomic_omni"),
    ("MecanumDriveController",      "mecanum"),
    ("AckermannSteeringController", "ackermann"),
    ("BicycleSteeringController",   "bicycle"),
    ("TricycleController",          "tricycle"),
    ("DiffDriveController",         "differential"),
    ("omni_wheel_drive",            "holonomic_omni"),
    ("mecanum_drive_controller",    "mecanum"),
    ("diff_drive_controller",       "differential"),
]

_KINEMATICS_PARAM_KEYS = frozenset({
    "wheel_radius", "wheel_separation", "wheel_separation_multiplier",
    "robot_radius", "wheel_offset", "wheel_offset_x", "wheel_offset_y",
    "wheelbase", "traction_wheel_radius", "wheel_count",
})


def _detect_drive_type_from_plugin(plugin_str):
    pl = plugin_str.lower()
    for fragment, dtype in _DRIVE_TYPE_MAP:
        if fragment.lower() in pl:
            return dtype
    return None


def _extract_ros2_control_config(all_yaml_files):
    """Scan ros2_control YAML files and return drive/kinematics/odometry config.

    Returns:
      drive_type                : str | None
      kinematics                : {param: value} | None
      controller_update_rate_hz : int | None
      odom_frame_ids            : {odom_topic, base_frame_id, odom_frame_id} | None
      controller_plugins        : [str, ...]
    """
    drive_type = None
    kinematics = {}
    update_rate = None
    odom_ids = {}
    plugins = []

    def _process(node, depth=0):
        nonlocal drive_type, update_rate
        if not isinstance(node, dict) or depth > 8:
            return
        # controller_manager block — has update_rate + controller type declarations
        cm = node.get("controller_manager")
        if isinstance(cm, dict):
            cm_params = cm.get("ros__parameters") or {}
            if isinstance(cm_params, dict):
                rate = cm_params.get("update_rate")
                if rate is not None and update_rate is None:
                    try:
                        update_rate = int(rate)
                    except (TypeError, ValueError):
                        pass
                # Controllers declared as  ctrl_name: {type: plugin.Type}
                for ctrl_k, ctrl_v in cm_params.items():
                    if isinstance(ctrl_v, dict):
                        ptype = ctrl_v.get("type", "")
                        if ptype and ptype not in plugins:
                            plugins.append(ptype)
                        if drive_type is None and ptype:
                            drive_type = _detect_drive_type_from_plugin(ptype) or drive_type

        # Any block with ros__parameters → kinematics keys + frame IDs
        rp = node.get("ros__parameters")
        if isinstance(rp, dict):
            ptype = rp.get("type") or node.get("type") or ""
            if ptype and "/" in ptype and ptype not in plugins:
                plugins.append(ptype)
            if drive_type is None and ptype:
                drive_type = _detect_drive_type_from_plugin(ptype) or drive_type
            for k, v in rp.items():
                if k in _KINEMATICS_PARAM_KEYS and isinstance(v, (int, float)):
                    kinematics[k] = v
                elif k in ("odom_frame_id", "odom_frame") and isinstance(v, str) and v:
                    odom_ids.setdefault("odom_frame_id", v)
                elif k in ("base_frame_id", "base_link_frame") and isinstance(v, str) and v:
                    odom_ids.setdefault("base_frame_id", v)
                elif k in ("odom_topic", "odometry_topic") and isinstance(v, str) and v:
                    odom_ids.setdefault("odom_topic", v)

        for k, v in node.items():
            if isinstance(v, dict):
                _process(v, depth + 1)

    for yf in all_yaml_files:
        data = _load_yaml(yf)
        if isinstance(data, dict):
            _process(data)

    return {
        "drive_type": drive_type,
        "kinematics": kinematics if kinematics else None,
        "controller_update_rate_hz": update_rate,
        "odom_frame_ids": odom_ids if odom_ids else None,
        "controller_plugins": plugins,
    }


# ---------------------------------------------------------------------------
# Hardware interfaces from URDF <ros2_control> tags
# ---------------------------------------------------------------------------

def _extract_hardware_interfaces_from_urdf(urdf_path):
    """Parse <ros2_control> elements and return a list of hardware interface records.

    Each record:
      name               : str
      type               : "system" | "actuator" | "sensor"
      plugin             : str
      joints             : [str, ...]
      command_interfaces : [str, ...]
      state_interfaces   : [str, ...]
      hardware_params    : {name: value} | None
    """
    records = []
    try:
        tree = ET.parse(str(urdf_path))
        root = tree.getroot()
    except Exception:
        return records

    for rc in root.findall(".//ros2_control"):
        name = rc.get("name", "")
        rc_type = rc.get("type", "system")
        plugin = ""
        hw_params = {}

        hw_el = rc.find("hardware")
        if hw_el is not None:
            pl = hw_el.find("plugin")
            if pl is not None:
                plugin = (pl.text or "").strip()
            for p in hw_el.findall("param"):
                pname = p.get("name", "")
                pval = (p.text or "").strip()
                if pname:
                    try:
                        pval = int(pval)
                    except (ValueError, TypeError):
                        try:
                            pval = float(pval)
                        except (ValueError, TypeError):
                            pass
                    hw_params[pname] = pval

        joints, cmd_ifaces, state_ifaces = [], [], []
        for joint_el in rc.findall("joint"):
            jname = joint_el.get("name", "")
            if jname:
                joints.append(jname)
            for ci in joint_el.findall("command_interface"):
                n = ci.get("name", "")
                if n and n not in cmd_ifaces:
                    cmd_ifaces.append(n)
            for si in joint_el.findall("state_interface"):
                n = si.get("name", "")
                if n and n not in state_ifaces:
                    state_ifaces.append(n)
        for sensor_el in rc.findall("sensor"):
            for si in sensor_el.findall("state_interface"):
                n = si.get("name", "")
                if n and n not in state_ifaces:
                    state_ifaces.append(n)

        records.append({
            "name": name,
            "type": rc_type,
            "plugin": plugin,
            "joints": joints,
            "command_interfaces": cmd_ifaces,
            "state_interfaces": state_ifaces,
            "hardware_params": hw_params if hw_params else None,
        })

    return records


# ---------------------------------------------------------------------------
# LiDAR config
# ---------------------------------------------------------------------------

_LIDAR_YAML_KEYS = frozenset({
    "laser_scan_topic_name", "product_name", "port_name", "serial_baudrate",
    "range_min", "range_max", "scan_mode", "ip_address",
    "filter_chain", "scan_filter_chain", "laser_scan_filter_chain",
})
_LIDAR_FNAME_HINTS = (
    "laser", "lidar", "rplidar", "sllidar", "urg", "velodyne",
    "ouster", "livox", "hokuyo", "ldlidar",
)
_LIDAR_EXTRACT_KEYS = frozenset({
    "product_name", "laser_scan_topic_name", "frame_id", "port_name",
    "serial_port", "serial_baudrate", "range_min", "range_max",
    "angle_min", "angle_max", "scan_frequency", "ip_address",
})


def _extract_lidar_config(all_yaml_files):
    """Return list of LiDAR config dicts found in YAML files."""
    configs = []
    for yf in all_yaml_files:
        fname = pathlib.Path(yf).name.lower()
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        all_keys = {str(k).lower() for k, _ in _walk_dict_items(data)}
        is_lidar = bool(_LIDAR_YAML_KEYS & all_keys) or \
                   any(h in fname for h in _LIDAR_FNAME_HINTS)
        if not is_lidar:
            continue
        cfg = {"config_file": pathlib.Path(yf).name, "path": yf}
        for k, v in _walk_dict_items(data):
            if str(k).lower() in _LIDAR_EXTRACT_KEYS:
                cfg[str(k).lower()] = v
        if "filter_chain" in all_keys or "scan_filter_chain" in all_keys or \
                "laser_scan_filter_chain" in all_keys:
            cfg["is_filter_chain"] = True
        configs.append(cfg)
    return configs


# ---------------------------------------------------------------------------
# Camera config
# ---------------------------------------------------------------------------

_CAMERA_YAML_KEYS = frozenset({
    "image_width", "image_height", "distortion_model", "camera_matrix",
    "distortion_coefficients", "i_pipeline_type", "i_fps", "i_enable_vio",
    "camera_name", "projection_matrix",
})
_CAMERA_FNAME_HINTS = (
    "camera", "oakd", "realsense", "webcam", "zed", "calibration",
    "basler", "flir", "v4l",
)
_CAMERA_EXTRACT_KEYS = frozenset({
    "image_width", "image_height", "distortion_model", "camera_name", "frame_id",
    "i_pipeline_type", "i_fps", "i_rgb_fps", "i_depth_fps",
    "i_enable_vio", "i_enable_imu",
})


def _extract_camera_configs(all_yaml_files):
    """Return list of camera config dicts found in YAML files."""
    configs = []
    for yf in all_yaml_files:
        fname = pathlib.Path(yf).name.lower()
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        all_keys = {str(k).lower() for k, _ in _walk_dict_items(data)}
        is_cam = bool(_CAMERA_YAML_KEYS & all_keys) or \
                 any(h in fname for h in _CAMERA_FNAME_HINTS)
        if not is_cam:
            continue
        cfg = {"config_file": pathlib.Path(yf).name, "path": yf}
        for k, v in _walk_dict_items(data):
            kl = str(k).lower()
            if kl in _CAMERA_EXTRACT_KEYS:
                cfg[kl] = v
            elif kl == "camera_matrix" and isinstance(v, dict):
                d_vals = v.get("data")
                if isinstance(d_vals, list) and len(d_vals) == 9:
                    cfg["camera_matrix"] = d_vals
        configs.append(cfg)
    return configs


# ---------------------------------------------------------------------------
# Localization config (EKF / AMCL)
# ---------------------------------------------------------------------------

_EKF_NODE_NAMES = frozenset({"ekf_filter_node", "ekf_node", "robot_localization"})
_AMCL_NODE_NAMES = frozenset({"amcl"})


def _extract_localization_config(all_yaml_files):
    """Return localization dict from EKF and/or AMCL YAML files, or None."""
    result = {}
    for yf in all_yaml_files:
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        ekf = _find_node_block(data, _EKF_NODE_NAMES)
        if isinstance(ekf, dict):
            result.setdefault("method", "ekf")
            result["config_file"] = pathlib.Path(yf).name
            for k, mapped in (
                ("frequency",       "frequency_hz"),
                ("odom_frame",      "odom_frame"),
                ("base_link_frame", "base_frame"),
                ("world_frame",     "world_frame"),
                ("two_d_mode",      "two_d_mode"),
                ("publish_tf",      "publish_tf"),
            ):
                v = ekf.get(k)
                if v is not None:
                    result[mapped] = v
            sources = {
                sk: ekf[sk]
                for sk in ekf
                if re.match(r"^(odom|imu|pose|twist|gps)\d+$", sk)
                and isinstance(ekf[sk], str)
            }
            if sources:
                result["fused_sources"] = sources

        amcl = _find_node_block(data, _AMCL_NODE_NAMES)
        if isinstance(amcl, dict):
            result.setdefault("method", "amcl")
            for k in ("robot_model_type", "scan_topic"):
                v = amcl.get(k)
                if v is not None:
                    result[f"amcl_{k}"] = v

    return result if result else None


# ---------------------------------------------------------------------------
# Nav2 config
# ---------------------------------------------------------------------------

_NAV2_SERVER_KEYS = frozenset({
    "controller_server", "planner_server", "behavior_server",
    "bt_navigator", "velocity_smoother", "local_costmap", "global_costmap",
})


def _extract_nav2_config(all_yaml_files):
    """Return nav2 config dict from nav2_params YAML files, or None."""
    result = {}
    for yf in all_yaml_files:
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        all_keys = {str(k).lower() for k, _ in _walk_dict_items(data)}
        if not (_NAV2_SERVER_KEYS & all_keys):
            continue
        result["config_file"] = pathlib.Path(yf).name

        # Planner
        planner = _find_node_block(data, {"planner_server"})
        if isinstance(planner, dict):
            plugins = planner.get("planner_plugins") or planner.get("plugin_names")
            if isinstance(plugins, list):
                result["planner_plugins"] = plugins
                for pname in plugins:
                    pb = planner.get(pname, {})
                    ptype = pb.get("plugin") if isinstance(pb, dict) else None
                    if ptype:
                        result.setdefault("planner_plugin_types", {})[pname] = ptype

        # Controller
        controller = _find_node_block(data, {"controller_server"})
        if isinstance(controller, dict):
            plugins = controller.get("controller_plugins") or controller.get("plugin_names")
            if isinstance(plugins, list):
                result["controller_plugins"] = plugins
                for pname in plugins:
                    pb = controller.get(pname, {})
                    ptype = pb.get("plugin") if isinstance(pb, dict) else None
                    if ptype:
                        result.setdefault("controller_plugin_types", {})[pname] = ptype
            for k in ("goal_checker_plugins", "progress_checker_plugins"):
                v = controller.get(k)
                if isinstance(v, list):
                    result[k] = v
            for k, v in _walk_dict_items(controller):
                kl = str(k).lower()
                if kl == "xy_goal_tolerance" and isinstance(v, (int, float)):
                    result.setdefault("xy_goal_tolerance", v)
                elif kl == "yaw_goal_tolerance" and isinstance(v, (int, float)):
                    result.setdefault("yaw_goal_tolerance", v)

        # Behaviors
        behavior = _find_node_block(data, {"behavior_server"})
        if isinstance(behavior, dict):
            behaviors = behavior.get("behavior_plugins") or behavior.get("plugin_names")
            if isinstance(behaviors, list):
                result["behavior_plugins"] = behaviors

        # Costmap
        for cm_key, out_key in (("local_costmap", "local"), ("global_costmap", "global")):
            cm = _find_node_block(data, {cm_key})
            if isinstance(cm, dict):
                inner = cm.get(cm_key) or cm
                rp = (inner.get("ros__parameters") if isinstance(inner, dict) else None) or inner
                if isinstance(rp, dict):
                    res = rp.get("resolution")
                    if res is not None:
                        result[f"{out_key}_costmap_resolution"] = res
                    infl = rp.get("inflation_radius")
                    if infl is not None:
                        result.setdefault("inflation_radius", infl)

        # Velocity smoother
        vs = _find_node_block(data, {"velocity_smoother"})
        if isinstance(vs, dict):
            for k in ("max_velocity", "max_accel", "max_acceleration"):
                v = vs.get(k)
                if v is not None:
                    result[f"velocity_smoother_{k}"] = v

        if result:
            break   # first nav2 YAML is enough

    return result if result else None


# ---------------------------------------------------------------------------
# Teleop + e-stop config
# ---------------------------------------------------------------------------

_TELEOP_NODE_NAMES = frozenset({
    "teleop_twist_joy_node", "teleop_twist_joy", "joy_teleop",
    "teleop_node", "joy_node",
})
_TELEOP_FNAME_HINTS = ("teleop", "joy")
_TELEOP_AXIS_KEYS = frozenset({
    "axis_linear", "axis_linear_x", "axis_linear_y",
    "axis_angular", "axis_angular_yaw",
    "enable_button", "enable_turbo_button",
    "scale_linear", "scale_linear_x", "scale_linear_y",
    "scale_angular", "scale_angular_yaw",
})


def _extract_teleop_and_estop(all_yaml_files):
    """Return (teleop_config_dict, estop_config_dict) from teleop YAML files.

    Both may be None when not found.
    """
    teleop = None
    estop = None

    for yf in all_yaml_files:
        fname = pathlib.Path(yf).name.lower()
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue

        # Find the teleop parameter block
        block = None
        for tname in _TELEOP_NODE_NAMES:
            b = data.get(tname)
            if isinstance(b, dict):
                block = b.get("ros__parameters") or b
                break
        if block is None and any(h in fname for h in _TELEOP_FNAME_HINTS):
            # Search one level deep for any node with teleop axis keys
            for k, v in data.items():
                if isinstance(v, dict):
                    rp = v.get("ros__parameters") or v
                    rp_keys = {str(kk).lower() for kk in rp} if isinstance(rp, dict) else set()
                    if _TELEOP_AXIS_KEYS & rp_keys:
                        block = rp
                        break
            if block is None:
                block = data

        if block is None:
            continue

        cfg = {"config_file": pathlib.Path(yf).name}

        # Topic
        for tk in ("topic_name", "publish_topic", "cmd_vel_topic"):
            v = block.get(tk)
            if isinstance(v, str) and v:
                cfg["cmd_vel_topic"] = v
                break

        # Fallback: joy_teleop action format — topic config nested under "teleop" key
        # block = {"teleop": {type: topic, topic_name: ..., interface_type: ...}, ...}
        if "cmd_vel_topic" not in cfg:
            joy_topic = block.get("teleop")
            if isinstance(joy_topic, dict) and joy_topic.get("type") == "topic":
                t_name = joy_topic.get("topic_name")
                t_type = joy_topic.get("interface_type")
                if isinstance(t_name, str) and t_name:
                    cfg["cmd_vel_topic"] = t_name
                if isinstance(t_type, str) and t_type:
                    cfg["msg_type"] = t_type
                # axis_mappings: {"twist-linear-x": {"axis": N, "scale": N}, ...}
                axis_m = joy_topic.get("axis_mappings", {})
                if isinstance(axis_m, dict):
                    joy_scales = {}
                    for ak, av in axis_m.items():
                        if isinstance(av, dict) and "scale" in av:
                            ak_n = ak.replace("twist-", "").replace("-", "_")
                            if "linear_x" in ak_n:
                                joy_scales["scale_linear_x"] = av["scale"]
                            elif "linear_y" in ak_n:
                                joy_scales["scale_linear_y"] = av["scale"]
                            elif "angular" in ak_n:
                                joy_scales["scale_angular_z"] = av["scale"]
                    if joy_scales and "scales" not in cfg:
                        cfg["scales"] = joy_scales
                deadman = joy_topic.get("deadman_buttons")
                if deadman is not None and "deadman_button" not in cfg:
                    cfg["deadman_button"] = deadman

        # Axis mappings
        axis = {k: block[k] for k in ("axis_linear", "axis_linear_x", "axis_linear_y",
                                       "axis_angular", "axis_angular_yaw")
                if k in block}
        if axis:
            cfg["axis_mappings"] = axis

        # Scales
        scales = {k: block[k] for k in ("scale_linear", "scale_linear_x",
                                          "scale_linear_y", "scale_angular",
                                          "scale_angular_yaw", "scale_linear_turbo")
                  if k in block}
        if scales:
            cfg["scales"] = scales

        # Buttons
        for k in ("enable_button", "enable_turbo_button", "deadman_button"):
            v = block.get(k)
            if v is not None:
                cfg[k] = v

        # Message type
        msg_type = block.get("interface_type") or block.get("message_type")
        if msg_type:
            cfg["msg_type"] = msg_type

        # E-stop service embedded in teleop block
        for ek in ("emergency_stop", "estop_service", "e_stop"):
            ev = block.get(ek)
            if isinstance(ev, str) and ev:
                estop = {"service_name": ev, "source": pathlib.Path(yf).name}
                break

        # Fallback: joy_teleop action format — estop_enable / estop_disable service entries
        # block = {"estop_enable": {type: service, service_name: ..., buttons: [...]}, ...}
        if estop is None:
            for bk, bv in block.items():
                if not (isinstance(bv, dict) and bv.get("type") == "service"):
                    continue
                if "estop" not in bk.lower():
                    continue
                svc = bv.get("service_name")
                svc_type = bv.get("interface_type")
                sr_data = (bv.get("service_request") or {}).get("data")
                # Use the "enable" / activate entry (data: true or key contains "enable")
                if svc and sr_data is not False:
                    estop = {
                        "service_name": svc,
                        "service_type": svc_type,
                        "source": pathlib.Path(yf).name,
                        "activate_buttons": bv.get("buttons"),
                    }
                    # Find deactivate entry (data: false)
                    for bk2, bv2 in block.items():
                        if bk2 == bk or not isinstance(bv2, dict):
                            continue
                        if bv2.get("type") == "service" and "estop" in bk2.lower():
                            sr2 = (bv2.get("service_request") or {}).get("data")
                            if sr2 is False:
                                estop["deactivate_buttons"] = bv2.get("buttons")
                    break

        if len(cfg) > 1:
            teleop = cfg
            break

    # Fallback estop search across all YAML files
    if estop is None:
        for yf in all_yaml_files:
            data = _load_yaml(yf)
            if not isinstance(data, dict):
                continue
            for k, v in _walk_dict_items(data):
                kl = str(k).lower()
                if kl in ("emergency_stop", "estop", "e_stop"):
                    svc = v if isinstance(v, str) else \
                          (v.get("service_name") or v.get("name") if isinstance(v, dict) else None)
                    if svc:
                        estop = {"service_name": svc, "source": pathlib.Path(yf).name}
                        break
            if estop:
                break

    return teleop, estop


def _extract_teleop_limits(yaml_files):
    """Extract per-axis velocity limits (scales) from all teleop YAML configs.

    Returns {sources: [...], binding: {linear_x, linear_y, angular_z}} where
    each source has one entry per teleop YAML that declares at least one scale,
    and binding is the minimum across all sources per axis.
    Returns None when no teleop scales are found.
    """
    sources = []
    best_lx: Optional[float] = None
    best_ly: Optional[float] = None
    best_az: Optional[float] = None

    def _upd(cur, val):
        if val is None:
            return cur
        fv = abs(float(val))
        if fv <= 0:
            return cur
        return fv if cur is None else min(cur, fv)

    for yf in yaml_files:
        fname = pathlib.Path(yf).name.lower()
        if not any(h in fname for h in _TELEOP_FNAME_HINTS):
            continue
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue

        lx = ly = az = None

        # joy_teleop nested format: joy_teleop.ros__parameters.teleop.axis_mappings
        for tname in _TELEOP_NODE_NAMES:
            block = data.get(tname)
            if not isinstance(block, dict):
                continue
            rp = block.get("ros__parameters") or block
            if not isinstance(rp, dict):
                continue
            joy_topic = rp.get("teleop")
            if isinstance(joy_topic, dict) and joy_topic.get("type") == "topic":
                axis_m = joy_topic.get("axis_mappings", {})
                if isinstance(axis_m, dict):
                    for ak, av in axis_m.items():
                        if isinstance(av, dict) and "scale" in av:
                            ak_n = ak.replace("twist-", "").replace("-", "_")
                            if "linear_x" in ak_n:
                                lx = av["scale"]
                            elif "linear_y" in ak_n:
                                ly = av["scale"]
                            elif "angular" in ak_n:
                                az = av["scale"]
            # Traditional teleop_twist_joy flat keys
            if lx is None:
                lx = rp.get("scale_linear_x") or rp.get("scale_linear")
            if ly is None:
                ly = rp.get("scale_linear_y")
            if az is None:
                az = rp.get("scale_angular_yaw") or rp.get("scale_angular")
            if any(v is not None for v in (lx, ly, az)):
                break

        if not any(v is not None for v in (lx, ly, az)):
            continue

        sources.append({
            "file": pathlib.Path(yf).name,
            "path": yf,
            "linear_x": abs(float(lx)) if lx is not None else None,
            "linear_y": abs(float(ly)) if ly is not None else None,
            "angular_z": abs(float(az)) if az is not None else None,
        })
        best_lx = _upd(best_lx, lx)
        best_ly = _upd(best_ly, ly)
        best_az = _upd(best_az, az)

    if not sources:
        return None

    return {
        "sources": sources,
        "binding": {
            "linear_x": best_lx,
            "linear_y": best_ly,
            "angular_z": best_az,
        },
    }


# ---------------------------------------------------------------------------
# TF frame inventory
# ---------------------------------------------------------------------------

_FRAME_KEY_MAP = {
    "map_frame":      "map_frame",
    "global_frame":   "map_frame",
    "odom_frame":     "odom_frame",
    "odom_frame_id":  "odom_frame",
    "base_link_frame":"base_frame",
    "base_frame_id":  "base_frame",
    "base_frame":     "base_frame",
}


def _extract_tf_frames(all_urdf_files, all_yaml_files):
    """Return TF frame inventory from URDF link names and config YAML frame IDs."""
    urdf_links = []
    seen_links: set = set()
    for uf in all_urdf_files:
        try:
            tree = ET.parse(str(uf))
            root = tree.getroot()
            for link_el in root.findall(".//link"):
                lname = link_el.get("name", "")
                # Skip unresolved xacro substitution variables
                if not lname or "${" in lname:
                    continue
                if lname not in seen_links:
                    seen_links.add(lname)
                    urdf_links.append(lname)
        except Exception:
            continue

    frames = {v: None for v in ("map_frame", "odom_frame", "base_frame")}
    for yf in all_yaml_files:
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        for k, v in _walk_dict_items(data):
            kl = str(k).lower()
            if kl not in _FRAME_KEY_MAP or not isinstance(v, str) or not v:
                continue
            target = _FRAME_KEY_MAP[kl]
            if frames.get(target) is None:
                # world_frame in EKF can be "map" or "odom" — classify by value
                if kl == "world_frame":
                    target = "map_frame" if "map" in v.lower() else "odom_frame"
                frames[target] = v

    return {
        "urdf_links": urdf_links,
        "map_frame": frames["map_frame"],
        "odom_frame": frames["odom_frame"],
        "base_frame": frames["base_frame"],
    }


# ---------------------------------------------------------------------------
# Launch configurations (args with choices) + active controllers
# ---------------------------------------------------------------------------

def _extract_launch_arg_choices(launch_file):
    """Return {arg_name: {default, choices, description}} from a Python launch file.

    Parses DeclareLaunchArgument calls.  Falls back to {} for non-Python files.
    """
    path = pathlib.Path(launch_file)
    if not path.name.endswith(".launch.py"):
        return {}
    import ast as _ast
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        tree = _ast.parse(text, filename=str(path))
    except Exception:
        return {}
    result = {}
    for node in _ast.walk(tree):
        if not isinstance(node, _ast.Call):
            continue
        if _ast_call_name(node) != "DeclareLaunchArgument":
            continue
        if not node.args:
            continue
        arg_name = _ast_to_str(node.args[0])
        if not arg_name or arg_name.startswith("$"):
            continue
        entry = {}
        for kw in node.keywords:
            if kw.arg == "default_value":
                entry["default"] = _ast_to_str(kw.value)
            elif kw.arg == "choices" and isinstance(kw.value, (_ast.List, _ast.Tuple)):
                choices = [_ast_to_str(e) for e in kw.value.elts]
                entry["choices"] = [c for c in choices if c and not c.startswith("$")]
            elif kw.arg == "description":
                entry["description"] = _ast_to_str(kw.value)
        if entry:
            result[arg_name] = entry
    return result


def _merge_launch_args(arg_meta, live_args):
    """Merge AST-derived arg metadata with live-detected arg values.

    *arg_meta*   — ``{name: {default?, choices?, description?}}`` from
                   ``_extract_launch_arg_choices``; values come from the
                   literal source code, so they are always populated.
    *live_args*  — ``{name: str_or_None}`` from ``_query_launch_args``;
                   a non-None value is a runtime-resolved default that may
                   differ from the literal (e.g. when the default is a
                   LaunchConfiguration reference).

    Merge rules:
    - AST metadata is the base (gives default + choices + description).
    - A non-None *live_args* value overrides the AST default.
    - Args present only in *live_args* (not seen by AST) are included with
      whatever the live parser found.
    - Entries with no metadata at all are dropped.

    Returns:
        ``{name: {default, choices?, description?}}`` — guaranteed no None values.
    """
    result: dict = {}
    for name in sorted(set(arg_meta) | set(live_args)):
        entry = dict(arg_meta.get(name, {}))
        live_val = live_args.get(name)
        if live_val is not None:
            entry["default"] = live_val
        if entry:               # skip args with no metadata from either source
            result[name] = entry
    return result


def _extract_active_controllers(all_launch_files):
    """Return sorted list of unique controller names spawned across all launch files.

    Parses Python launch files for Node(executable='spawner', ...) calls.
    """
    import ast as _ast
    controllers = []
    seen: set = set()
    for lf in all_launch_files:
        path = pathlib.Path(lf)
        if not path.name.endswith(".launch.py"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            tree = _ast.parse(text, filename=str(path))
        except Exception:
            continue
        for node in _ast.walk(tree):
            if not isinstance(node, _ast.Call):
                continue
            fname = _ast_call_name(node)
            ctrl_name = None
            if fname == "Node":
                exe = None
                args_list = None
                for kw in node.keywords:
                    if kw.arg == "executable":
                        exe = _ast_to_str(kw.value)
                    elif kw.arg == "arguments" and isinstance(kw.value, (_ast.List, _ast.Tuple)):
                        args_list = [_ast_to_str(e) for e in kw.value.elts]
                if exe and "spawner" in exe.lower():
                    if node.args:
                        ctrl_name = _ast_to_str(node.args[0])
                    elif args_list:
                        ctrl_name = next(
                            (a for a in args_list
                             if a and not a.startswith("-") and not a.startswith("$")),
                            None,
                        )
            elif "spawner" in fname.lower() and fname != "Node":
                ctrl_name = _ast_to_str(node.args[0]) if node.args else None
                if not ctrl_name:
                    for kw in node.keywords:
                        if kw.arg in ("controller_names", "controller_name", "name"):
                            ctrl_name = _ast_to_str(kw.value)

            if ctrl_name and not ctrl_name.startswith("$") and ctrl_name not in seen:
                seen.add(ctrl_name)
                controllers.append(ctrl_name)
    return sorted(controllers)


# ---------------------------------------------------------------------------
# Maps (nav2 map-server YAML)
# ---------------------------------------------------------------------------

def _extract_maps(all_yaml_files):
    """Return a list of map metadata records found in YAML files.

    A map YAML (nav2 map-server / map_server format) is identified by the
    simultaneous presence of ``image``, ``resolution``, and ``origin`` at the
    top level.

    Each record:
      file       : filename
      path       : absolute path
      name       : stem of the filename (human label)
      type       : "keepout" | "speed" | "occupancy"
      resolution : metres-per-pixel (float)
      image      : path to the PGM/PNG map image (relative or absolute)
    """
    maps = []
    for yf in all_yaml_files:
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        # Must have all three top-level keys that distinguish a map YAML from
        # a parameter file that happens to have an "image" key.
        if not all(k in data for k in ("image", "resolution", "origin")):
            continue
        path = pathlib.Path(yf)
        stem = path.stem.lower()
        map_type = (
            "keepout" if "keepout" in stem
            else "speed" if any(w in stem for w in ("speed", "restriction", "limit"))
            else "occupancy"
        )
        maps.append({
            "file": path.name,
            "path": yf,
            "name": path.stem,
            "type": map_type,
            "resolution": data.get("resolution"),
            "image": data.get("image"),
        })
    return maps


# ---------------------------------------------------------------------------
# Sensor filter pipeline (laser_filters / sensor_filters)
# ---------------------------------------------------------------------------

def _extract_sensor_filter_pipeline(all_yaml_files):
    """Return a list of filter entries from sensor/laser filter-chain YAMLs.

    Recognises:
    - ``filter_chain``
    - ``laser_scan_filter_chain``
    - ``scan_filter_chain``
    - ``filters`` (when the enclosing node key contains "filter")

    Each entry:
      name        : filter name string (may be empty)
      type        : filter plugin type string
      source_file : filename the filter was extracted from
      params      : {key: value} of filter-specific params (may be absent)
    """
    pipeline = []
    for yf in all_yaml_files:
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        found = False
        for key, val in _walk_dict_items(data, max_depth=4):
            if key in ("filter_chain", "laser_scan_filter_chain",
                       "scan_filter_chain") and isinstance(val, list):
                for entry in val:
                    if not isinstance(entry, dict):
                        continue
                    rec = {
                        "name": entry.get("name", ""),
                        "type": entry.get("type", ""),
                        "source_file": pathlib.Path(yf).name,
                    }
                    params = entry.get("params") or entry.get("ros__parameters")
                    if isinstance(params, dict) and params:
                        rec["params"] = params
                    pipeline.append(rec)
                found = True
                break  # only first matching key per file
        if not found:
            continue  # avoid duplicate iterations
    return pipeline if pipeline else None


# ---------------------------------------------------------------------------
# IMU configuration
# ---------------------------------------------------------------------------

_IMU_BROADCASTER_NAMES = frozenset({
    "imu_sensor_broadcaster", "imu_broadcaster",
    "imu_filter_madgwick", "imu_filter_node",
    "imu_complementary_filter", "imu_sensor_node",
})

_IMU_HW_HINTS = frozenset({"bno", "imu", "mpu", "ahrs", "vectornav", "xsens", "microstrain"})

_IMU_HW_PARAM_KEYS = frozenset({
    "sensor_mode", "i2c_address", "i2c_bus", "baud_rate",
    "port", "frame_id", "data_rate", "calibration_file",
})


def _extract_imu_config(hardware_interfaces, all_yaml_files):
    """Return an IMU configuration dict derived from hardware_interfaces + YAML.

    Fields (all optional):
      plugin           : ros2_control hardware plugin string
      state_interfaces : [str, ...]
      hardware_params  : {key: value}  (raw hardware params)
      broadcaster      : {frame_id, sensor_name, publish_rate, ...}
    """
    imu_config: dict = {}

    # --- hardware_interfaces entry ---
    for iface in hardware_interfaces:
        plugin = (iface.get("plugin") or "").lower()
        if any(h in plugin for h in _IMU_HW_HINTS):
            imu_config["plugin"] = iface.get("plugin")
            si = iface.get("state_interfaces")
            if si:
                imu_config["state_interfaces"] = si
            hw_params = iface.get("hardware_params") or {}
            if hw_params:
                imu_config["hardware_params"] = hw_params
            break

    # --- imu broadcaster / filter YAML block ---
    for yf in all_yaml_files:
        data = _load_yaml(yf)
        if not isinstance(data, dict):
            continue
        block = _find_node_block(data, _IMU_BROADCASTER_NAMES)
        if block:
            bc = {k: block[k] for k in (
                "frame_id", "sensor_name", "publish_rate",
                "filter_world_frame", "use_mag", "stationary_threshold",
            ) if k in block}
            if bc:
                imu_config["broadcaster"] = bc
            break

    return imu_config if imu_config else None


# ---------------------------------------------------------------------------
# Package dependencies
# ---------------------------------------------------------------------------

def _extract_package_dependencies(ws_packages):
    """Return {pkg_name: [exec_depend, ...]} for all primary packages.

    Only primary packages are included — dependency packages are workspace-local
    drivers whose own dependency lists are not relevant to the target robot's
    runtime requirements.
    """
    result = {}
    for pkg in ws_packages:
        if pkg.get("role", "primary") != "primary":
            continue
        deps = pkg.get("deps", [])
        if deps:
            result[pkg["name"]] = deps
    return result if result else None


# ---------------------------------------------------------------------------
# Sensor / actuator mount classification
# ---------------------------------------------------------------------------

# Ordered list of (keyword_set, sensor_type) pairs.
# First match wins; keywords are checked as substrings of the lowercased
# child link name (e.g. "camera_link" → "camera", "lidar_front" → "lidar").
_SENSOR_LINK_PATTERNS = [
    ({"camera", "cam", "rgb", "color"},                                        "camera"),
    ({"depth", "rgbd", "d435", "d415", "d455", "d457", "l515", "realsense"},  "depth_camera"),
    ({"lidar", "laser", "scan", "velodyne", "hokuyo", "rplidar", "lms",
      "vlp", "ouster", "livox", "hesai"},                                      "lidar"),
    ({"imu", "ahrs", "mpu", "bno", "vectornav", "xsens", "microstrain"},      "imu"),
    ({"sonar", "ultrasonic", "ultrasound", "ping"},                            "sonar"),
    ({"gps", "gnss", "navsat"},                                                "gps"),
    ({"gripper", "hand", "finger", "ee_link", "tool_link", "eef",
      "end_effector"},                                                          "gripper"),
]


def _classify_sensor_link(link_name):
    """Return the sensor type string for a URDF link name, or ``None``.

    Matches are substring-based on the lowercased link name, with the first
    entry in ``_SENSOR_LINK_PATTERNS`` that has any keyword hit winning.
    Returns ``None`` when the link is not recognised as a sensor or actuator.
    """
    ll = link_name.lower()
    for keywords, stype in _SENSOR_LINK_PATTERNS:
        if any(kw in ll for kw in keywords):
            return stype
    return None


def _image_rotation_from_roll(roll_rad):
    """Return image-correction degrees for a camera roll angle, or 0.

    ≈ ±π  → 180 (upside-down)
    ≈ +π/2 → 90  (on its left side)
    ≈ −π/2 → -90 (on its right side)
    """
    if abs(abs(roll_rad) - math.pi) < 0.2:
        return 180
    if abs(roll_rad - math.pi / 2.0) < 0.2:
        return 90
    if abs(roll_rad + math.pi / 2.0) < 0.2:
        return -90
    return 0


def _extract_sensor_mounts_from_urdf(urdf_path):
    """Parse a URDF and return mount pose info for every sensor and actuator.

    Inspects all joints whose **child link name** matches any entry in
    ``_SENSOR_LINK_PATTERNS`` — cameras, depth cameras, LiDARs, IMUs, sonars,
    GPS units, grippers, and so on.  For each match the joint's
    ``<origin xyz="…" rpy="…"/>`` is read and stored verbatim so that any
    downstream command can reason about the sensor's physical placement.

    For **visual** sensors (``camera``, ``depth_camera``) the field
    ``image_rotation_deg`` is also included: the suggested image correction
    derived from the roll angle so that captured frames can be straightened
    before display or delivery.

    Returns a list of dicts (empty list when the URDF cannot be read or no
    sensor/actuator joints are found):

    .. code-block:: json

        {
          "joint":       "lidar_joint",
          "link":        "lidar_front",
          "sensor_type": "lidar",
          "xyz":         [0.15, 0.0, 0.25],
          "rpy":         [0.0, 0.0, 3.14159],

          // Only for camera / depth_camera:
          "image_rotation_deg": 180
        }
    """
    try:
        tree = ET.parse(str(urdf_path))
        root = tree.getroot()
    except Exception:
        return []

    mounts = []
    for joint in root.findall(".//joint"):
        child_el = joint.find("child")
        if child_el is None:
            continue
        child_link = child_el.get("link", "")
        sensor_type = _classify_sensor_link(child_link)
        if sensor_type is None:
            continue

        origin_el = joint.find("origin")
        if origin_el is None:
            xyz = [0.0, 0.0, 0.0]
            rpy = [0.0, 0.0, 0.0]
        else:
            try:
                xyz = [float(v) for v in origin_el.get("xyz", "0 0 0").split()]
                if len(xyz) != 3:
                    xyz = [0.0, 0.0, 0.0]
            except ValueError:
                xyz = [0.0, 0.0, 0.0]
            try:
                rpy = [float(v) for v in origin_el.get("rpy", "0 0 0").split()]
                if len(rpy) != 3:
                    rpy = [0.0, 0.0, 0.0]
            except ValueError:
                rpy = [0.0, 0.0, 0.0]

        entry = {
            "joint":       joint.get("name", ""),
            "link":        child_link,
            "sensor_type": sensor_type,
            "xyz":         [round(v, 6) for v in xyz],
            "rpy":         [round(v, 6) for v in rpy],
        }
        # For visual sensors add the actionable image correction.
        if sensor_type in ("camera", "depth_camera"):
            entry["image_rotation_deg"] = _image_rotation_from_roll(rpy[0])

        mounts.append(entry)

    return mounts


# ---------------------------------------------------------------------------
# Source code hinting (grep-based, lightweight)
# ---------------------------------------------------------------------------

def _grep_source(paths, patterns, max_files=30):
    """Return True if any of *patterns* (regex strings) appears in any of *paths*."""
    compiled = [re.compile(p, re.I) for p in patterns]
    for f in paths[:max_files]:
        try:
            text = pathlib.Path(f).read_text(encoding="utf-8", errors="replace")
            for pat in compiled:
                if pat.search(text):
                    return True
        except Exception:
            continue
    return False


def _pkg_match_hints(hint_set, pkg_names):
    """Match hints against package names using token-level matching.

    Splits each package name on ``_`` and ``-`` before matching, so a hint
    like ``"nao"`` does **not** match ``"autonomous"`` or ``"scenario"`` — it
    only matches packages that have ``nao`` as a distinct token (e.g.
    ``"nao_robot"`` → tokens {``nao``, ``robot``}).

    Multi-token hints (those containing ``_`` or ``-``) fall back to substring
    matching on the full package name because they are already specific enough
    (e.g. ``"diff_drive"`` unambiguously identifies a mobile-base package).

    Returns a list of ``(hint, package_name)`` pairs for up to 5 matches
    (enough for evidence without flooding the output).
    """
    matches = []
    for pkg in pkg_names:
        pkg_lower = pkg.lower()
        # Token set for exact single-word hint matching.
        tokens = set(re.split(r"[_\-]+", pkg_lower)) - {"", "ros", "ros2", "pkg"}
        for h in hint_set:
            if "_" in h or "-" in h:
                # Compound hint → substring match is safe (specific enough).
                if h in pkg_lower:
                    matches.append((h, pkg))
                    break
            else:
                # Single-word hint → exact token match to avoid "nao" ⊂ "autonomous".
                if h in tokens:
                    matches.append((h, pkg))
                    break
        if len(matches) >= 5:
            break
    return matches


def _src_match_hints(hint_set, src_files, word_boundary=False, max_files=50):
    """Match hints against source file content.

    When *word_boundary* is True the patterns are wrapped in ``\\b`` anchors so
    that short tokens like ``"nao"`` do not match inside longer identifiers.

    Returns a list of ``(hint, filename)`` pairs (capped at 5 for readability).
    """
    if word_boundary:
        compiled = [(h, re.compile(r"\b" + re.escape(h) + r"\b", re.I))
                    for h in hint_set]
    else:
        compiled = [(h, re.compile(re.escape(h), re.I)) for h in hint_set]

    matches = []
    for fpath in src_files[:max_files]:
        try:
            text = pathlib.Path(fpath).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        fname = pathlib.Path(fpath).name
        for h, pat in compiled:
            if pat.search(text):
                matches.append((h, fname))
                if len(matches) >= 5:
                    return matches
    return matches


# ---------------------------------------------------------------------------
# URDF-based type evidence helpers
# ---------------------------------------------------------------------------

def _urdf_humanoid_evidence(joint_limits):
    """Return evidence strings when URDF joint names suggest a humanoid robot.

    Looks for joints whose names contain torso, neck, head, shoulder, elbow,
    wrist, ankle, knee, or hip axis names (hip_pitch / hip_roll / hip_yaw).
    Requires **≥ 4** such joints to reduce false positives from robots that
    happen to have a single ``head_pan`` joint.
    """
    _HUMANOID_JOINT_PATTERNS = {
        "torso", "neck", "head", "shoulder", "elbow", "wrist",
        "ankle", "knee", "hip_pitch", "hip_roll", "hip_yaw",
    }
    found = []
    for jname in joint_limits:
        jl = jname.lower()
        for pat in _HUMANOID_JOINT_PATTERNS:
            if pat in jl:
                found.append(f"urdf-joint:{jname}")
                break
    return found if len(found) >= 4 else []


def _urdf_legged_evidence(joint_limits):
    """Return evidence strings when URDF joint names suggest a legged robot.

    Looks for FL/FR/RL/RR leg-naming prefixes or _hip_ / _knee_ / _ankle_
    substrings.  Requires **≥ 4** such joints to distinguish a true legged
    platform from, e.g., a pan-tilt mechanism with two rotational joints.
    """
    _LEG_PREFIXES = {"fl_", "fr_", "rl_", "rr_", "lf_", "rf_", "lb_", "rb_"}
    _LEG_SUBSTRINGS = {"_hip_", "_knee_", "_ankle_", "_leg_", "_thigh_", "_shin_"}
    found = []
    for jname in joint_limits:
        jl = jname.lower()
        if any(jl.startswith(p) for p in _LEG_PREFIXES) or \
                any(s in jl for s in _LEG_SUBSTRINGS):
            found.append(f"urdf-joint:{jname}")
    return found if len(found) >= 4 else []


# ---------------------------------------------------------------------------
# Live graph fallback
# ---------------------------------------------------------------------------

def _live_fallback_topics(timeout=8):
    """Return (topic_list, type_map) from the live ROS 2 graph."""
    try:
        import rclpy
        from ros2_utils import ROS2CLI, ros2_context
        with ros2_context():
            node = ROS2CLI()
            topics_and_types = node.get_topic_names_and_types()
        topic_names = [n for n, _ in topics_and_types]
        type_map = {n: (tl[0] if tl else "") for n, tl in topics_and_types}
        return topic_names, type_map
    except Exception:
        return [], {}


# ---------------------------------------------------------------------------
# Robot type detection
# ---------------------------------------------------------------------------

def _detect_robot_type(ws_pkg_names, all_src_files, velocity_topics,
                       joint_limits, has_nav2, robot_type_override=None):
    """Return ``(robot_type, robot_features, evidence)`` from static workspace signals.

    Parameters
    ----------
    ws_pkg_names : list[str]
        Package names from the workspace ``src/`` tree **only**.
        Ament-installed infrastructure packages are deliberately excluded —
        they don't indicate the robot's own type.
    all_src_files : list[str]
        Source paths for grep-based hinting.
    velocity_topics : list[str]
        Velocity topics discovered in the workspace.
    joint_limits : dict
        Joint names keyed from URDF files.
    has_nav2 : bool
        Whether Nav2 packages are present.
    robot_type_override : str | None
        If set, skip detection and use this value directly (user-specified).

    Returns
    -------
    robot_type : str
        Primary type (one of ``_VALID_ROBOT_TYPES``).
    robot_features : list[str]
        Supplementary features detected alongside the primary type,
        e.g. ``["pantilt"]``.
    evidence : dict[str, list[str]]
        Per-label evidence strings explaining which signals matched.
        Keys are type/feature names; values are short signal descriptions.

    Detection philosophy
    --------------------
    - Package names are checked with **token-level** matching (split on ``_``/``-``)
      so ``"nao"`` does not spuriously match ``"autonomous"`` or ``"scenario"``.
    - Source-code grep uses **word-boundary** anchors for short / ambiguous tokens
      (humanoid, legged, pantilt) and plain substring match for long/compound ones.
    - Humanoid detection additionally requires URDF joint-name confirmation if the
      only signal is a source-code match (package match alone is sufficient).
    - Type detection runs on workspace packages only; installed ROS 2 infrastructure
      packages do not influence the robot type.
    - ``robot_features`` captures supplementary capabilities (pan-tilt, gimbal …)
      that enrich the primary type without changing it.
    """
    # ── User override ─────────────────────────────────────────────────────────
    if robot_type_override:
        safe = robot_type_override if robot_type_override in _VALID_ROBOT_TYPES \
            else "unknown"
        return (safe, [], {"override": [f"user-specified: {robot_type_override}"]})

    evidence: dict = {}

    # ── Helper: check one type and record evidence ────────────────────────────
    def _check(hint_set, label, word_boundary=False):
        pkg_hits = _pkg_match_hints(hint_set, ws_pkg_names)
        if pkg_hits:
            evidence[label] = [f"pkg:{p}" for _, p in pkg_hits[:5]]
            return True
        src_hits = _src_match_hints(hint_set, all_src_files,
                                    word_boundary=word_boundary)
        if src_hits:
            evidence[label] = [f"src:{f}" for _, f in src_hits[:5]]
            return True
        return False

    # ── Humanoid — strictest: pkg token match OR (URDF ≥4 joints) ─────────────
    # Source-only match is NOT accepted for humanoid because generic words in
    # comments / tutorial code cause false positives on non-humanoid robots.
    hum_pkg_hits = _pkg_match_hints(_HUMANOID_HINTS, ws_pkg_names)
    hum_urdf = _urdf_humanoid_evidence(joint_limits)
    has_humanoid = bool(hum_pkg_hits or hum_urdf)
    if has_humanoid:
        sigs = ([f"pkg:{p}" for _, p in hum_pkg_hits[:3]] + hum_urdf[:3])
        evidence["humanoid"] = sigs[:5]

    # ── Legged — pkg token OR URDF leg-joint pattern ──────────────────────────
    leg_pkg_hits = _pkg_match_hints(_LEGGED_HINTS, ws_pkg_names)
    leg_urdf = _urdf_legged_evidence(joint_limits)
    leg_src_hits = [] if (leg_pkg_hits or leg_urdf) else \
        _src_match_hints(_LEGGED_HINTS, all_src_files, word_boundary=True)
    has_legged = bool(leg_pkg_hits or leg_urdf or leg_src_hits)
    if has_legged:
        sigs = ([f"pkg:{p}" for _, p in leg_pkg_hits[:3]]
                + leg_urdf[:3]
                + [f"src:{f}" for _, f in leg_src_hits[:2]])
        evidence["legged"] = sigs[:5]

    # ── Aerial ─────────────────────────────────────────────────────────────────
    has_aerial = _check(_AERIAL_HINTS, "aerial")
    if not has_aerial and velocity_topics:
        aerial_topics = [t for t in velocity_topics
                         if "altitude" in t or "takeoff" in t or "land" in t]
        if aerial_topics:
            has_aerial = True
            evidence["aerial"] = [f"topic:{t}" for t in aerial_topics[:3]]

    # ── Underwater / surface vessel ────────────────────────────────────────────
    has_underwater = _check(_UNDERWATER_HINTS, "underwater", word_boundary=True)
    has_surface_vessel = _check(_SURFACE_VESSEL_HINTS, "surface_vessel", word_boundary=True)

    # ── Arm — pkg/src hints OR ≥3 non-wheel URDF joints ───────────────────────
    has_arm = _check(_ARM_HINTS, "arm", word_boundary=True)
    if not has_arm and joint_limits:
        non_wheel = [n for n in joint_limits if "wheel" not in n.lower()]
        if len(non_wheel) >= 3:
            has_arm = True
            evidence["arm"] = [f"urdf-joint:{j}" for j in non_wheel[:5]]

    # ── Mobile base — velocity topics or Nav2 or explicit hints ───────────────
    has_mobile = False
    mobile_sigs = []
    if velocity_topics:
        has_mobile = True
        mobile_sigs.extend(f"topic:{t}" for t in velocity_topics[:3])
    if has_nav2:
        has_mobile = True
        mobile_sigs.append("ament:nav2")
    if not has_mobile:
        has_mobile = _check(_MOBILE_HINTS, "mobile_base")
    elif mobile_sigs:
        evidence["mobile_base"] = mobile_sigs

    # ── Supplementary features (don't affect primary type) ────────────────────
    robot_features: list = []
    pt_pkg = _pkg_match_hints(_PANTILT_HINTS, ws_pkg_names)
    pt_src = [] if pt_pkg else \
        _src_match_hints(_PANTILT_HINTS, all_src_files, word_boundary=True)
    if pt_pkg or pt_src:
        robot_features.append("pantilt")
        sigs = ([f"pkg:{p}" for _, p in pt_pkg[:3]]
                + [f"src:{f}" for _, f in pt_src[:3]])
        evidence["pantilt"] = sigs[:5]

    # ── Priority resolution ────────────────────────────────────────────────────
    if has_humanoid:
        robot_type = "humanoid"
    elif has_legged:
        robot_type = "legged"
    elif has_aerial:
        robot_type = "aerial"
    elif has_underwater:
        robot_type = "underwater"
    elif has_surface_vessel:
        robot_type = "surface_vessel"
    elif has_mobile and has_arm:
        robot_type = "mobile_manipulator"
    elif has_arm:
        robot_type = "arm"
    elif has_mobile:
        robot_type = "mobile_base"
    else:
        robot_type = "unknown"

    return robot_type, robot_features, evidence


# ---------------------------------------------------------------------------
# Launch file detail keying
# ---------------------------------------------------------------------------

def _make_detail_key(launch_path, existing_keys):
    """Return a unique key for this launch file in the detail dict.

    Uses the actual filename from the workspace (e.g. ``bringup.launch.py``).
    If that basename is already taken by another launch file in a different
    package, falls back to ``<package_dir>/<basename>`` to disambiguate.
    No name derivation or stem stripping — the key is always directly readable
    from the filesystem.
    """
    path = pathlib.Path(launch_path)
    basename = path.name  # e.g. bringup.launch.py — taken verbatim
    if basename not in existing_keys:
        return basename
    # Disambiguate with the immediate parent-of-launch directory (package name).
    pkg_name = path.parent.parent.name  # heuristic: <pkg>/launch/<file>
    return f"{pkg_name}/{basename}"


# ---------------------------------------------------------------------------
# Full static scan
# ---------------------------------------------------------------------------

def _run_static_scan(ws_path, distro, allow_live=False,
                     robot_type_override=None, verbose=False,
                     pkg_filter=None):
    """Execute the full static scan and return a profile dict.

    *pkg_filter* is a comma-separated string or list of patterns that restrict
    which packages are included (e.g. ``"lekiwi"`` collects every package
    whose name or path contains ``"lekiwi"``).  When *None*, the entire
    ``<ws>/src/`` tree is included (legacy behaviour).
    """
    scan_steps = []

    # --- 1. Ament index ---
    scan_steps.append("ament_index")
    ament_pkgs = _scan_packages_from_ament()
    all_ament_pkg_names = sorted(ament_pkgs.keys())

    # --- 2. Workspace src walk ---
    scan_steps.append("workspace_walk")
    ws_data = _walk_workspace_src(ws_path, pkg_filter=pkg_filter) if ws_path else {
        "packages": [], "pkg_filter": [], "matched_dirs": [],
        "primary_packages": [], "dependency_packages": [],
    }
    ws_packages = ws_data["packages"]
    ws_pkg_names = [p["name"] for p in ws_packages]
    resolved_pkg_filter = ws_data.get("pkg_filter", [])
    matched_dirs = ws_data.get("matched_dirs", [])
    primary_packages = ws_data.get("primary_packages", ws_pkg_names)
    dependency_packages = ws_data.get("dependency_packages", [])

    # Aggregate all source artifacts.
    # all_* lists include BOTH primary and dependency packages so that
    # safety-limit YAML, hardware interface configs, and sensor hints from
    # workspace-local dependencies are captured.
    # primary_* lists contain ONLY primary packages and are used for robot-type
    # classification and for robot-specific output (camera configs, etc.) —
    # dependency driver source code must not influence these.
    all_launch_files = []
    all_yaml_files = []
    all_urdf_files = []
    all_src_files = []
    primary_pkg_names = []
    primary_src_files = []
    primary_yaml_files = []
    primary_urdf_files = []
    for pkg in ws_packages:
        role = pkg.get("role", "primary")
        all_launch_files.extend(pkg.get("launch_files", []))
        all_yaml_files.extend(pkg.get("yaml_files", []))
        all_urdf_files.extend(pkg.get("urdf_files", []))
        all_src_files.extend(pkg.get("src_files", []))
        if role != "dependency":
            primary_pkg_names.append(pkg["name"])
            primary_src_files.extend(pkg.get("src_files", []))
            primary_yaml_files.extend(pkg.get("yaml_files", []))
            primary_urdf_files.extend(pkg.get("urdf_files", []))

    # Deduplicate URDF paths — the same file may appear under both src/ and
    # install/ (symlinked), or be collected twice by the workspace walker.
    # Resolve each path to its real path so that symlinks are collapsed, then
    # keep insertion order.
    def _dedup_urdf_list(paths):
        seen, out = set(), []
        for p in paths:
            try:
                key = str(pathlib.Path(p).resolve())
            except OSError:
                key = p
            if key not in seen:
                seen.add(key)
                out.append(p)
        return out

    all_urdf_files = _dedup_urdf_list(all_urdf_files)
    primary_urdf_files = _dedup_urdf_list(primary_urdf_files)

    # --- 3. Safety limits from YAML ---
    # Each YAML file that contains at least one velocity limit is stored as a
    # separate source entry so the caller can see which config drove which limit.
    # The binding (most restrictive per axis across all sources) is computed here
    # and augmented in step 4 with URDF safety_controller values.
    scan_steps.append("yaml_limits")
    limit_sources: list = []   # [{file, path, linear_x, linear_y, angular_z}]
    best_lin_x, best_lin_y, best_ang_z = None, None, None
    joint_limits_by_model: dict = {}   # shared by YAML (step 3) and URDF (step 4)

    def _upd_best(current, candidate):
        if candidate is None or candidate <= 0:
            return current
        return float(candidate) if current is None else min(current, float(candidate))

    for yf in all_yaml_files:
        lx, ly, az = _extract_limits_from_yaml(yf)
        if any(v is not None for v in (lx, ly, az)):
            limit_sources.append({
                "file": pathlib.Path(yf).name,
                "path": yf,
                "linear_x": lx,
                "linear_y": ly,
                "angular_z": az,
            })
            best_lin_x = _upd_best(best_lin_x, lx)
            best_lin_y = _upd_best(best_lin_y, ly)
            best_ang_z = _upd_best(best_ang_z, az)
        # ros2_control joint_limits block: per-joint position limits and homing values.
        jl_yaml = _extract_joint_limits_from_yaml(yf)
        for jname, jdata in jl_yaml.items():
            joint_limits_by_model.setdefault("_yaml", {}).setdefault(jname, {}).update(jdata)

    # --- 4. Joint limits and sensor mounts from URDF ---
    # joint_limits_by_model: {model_name: {joint_name: {velocity, effort, lower, upper, ...}}}
    # Initialised before step 3 (YAML joint limits) so both loops share the same dict.
    # Each URDF file is stored under its own <robot name="…"> so that test or
    # example URDFs in the workspace cannot pollute the main robot's joint list.
    # YAML-sourced joint limits are stored under the "_yaml" key.
    scan_steps.append("urdf_limits")
    _flat_joint_limits: dict = {}      # flat — used only for type detection
    sensor_mounts: list = []
    seen_sensor_links: set = set()
    for uf in all_urdf_files:
        jl = _extract_joint_limits_from_urdf(uf)
        if jl:
            model_name = _get_urdf_robot_name(uf)
            joint_limits_by_model.setdefault(model_name, {}).update(jl)
            _flat_joint_limits.update(jl)
        # Per-joint ros2_control params: position_center_steps, min/max_position, etc.
        jp = _extract_joint_params_from_urdf(uf)
        if jp:
            model_name = _get_urdf_robot_name(uf)
            for jname, params in jp.items():
                joint_limits_by_model.setdefault(model_name, {}).setdefault(jname, {}).update(params)
        # safety_controller velocity (linear x from wheel joints).
        lin, _ang = _extract_safety_velocity_from_urdf(uf)
        best_lin_x = _upd_best(best_lin_x, lin)
        # <param name="max_vel_*"> / <param name="max_velocity"> in ros2_control blocks.
        plx, ply, paz = _extract_limits_from_urdf_params(uf)
        if any(v is not None for v in (plx, ply, paz)):
            limit_sources.append({
                "file": pathlib.Path(uf).name,
                "path": uf,
                "linear_x": plx,
                "linear_y": ply,
                "angular_z": paz,
            })
            best_lin_x = _upd_best(best_lin_x, plx)
            best_lin_y = _upd_best(best_lin_y, ply)
            best_ang_z = _upd_best(best_ang_z, paz)
        # Sensor / actuator mount poses — deduplicated by child link name.
        # Skip entries whose link/joint names contain unresolved xacro substitutions.
        for mount in _extract_sensor_mounts_from_urdf(uf):
            link = mount["link"]
            if "${" in link or "${" in mount.get("joint", ""):
                continue
            if link not in seen_sensor_links:
                seen_sensor_links.add(link)
                sensor_mounts.append(mount)

    # --- 4b. ros2_control config ---
    scan_steps.append("ros2_control_config")
    ros2_ctrl = _extract_ros2_control_config(all_yaml_files)

    # --- 4c. Hardware interfaces from URDF <ros2_control> tags ---
    # Deduplicate by (plugin, frozenset(joints)) fingerprint — the same physical
    # hardware block may appear in both a xacro-generated .urdf.xacro and the
    # compiled .urdf under a different <ros2_control name="..."> label.
    scan_steps.append("hardware_interfaces")
    hardware_interfaces: list = []
    seen_hw_names: set = set()
    seen_hw_fingerprints: set = set()
    for uf in all_urdf_files:
        for iface in _extract_hardware_interfaces_from_urdf(uf):
            fingerprint = (iface.get("plugin", ""), frozenset(iface.get("joints", [])))
            if iface["name"] not in seen_hw_names and fingerprint not in seen_hw_fingerprints:
                seen_hw_names.add(iface["name"])
                seen_hw_fingerprints.add(fingerprint)
                hardware_interfaces.append(iface)

    # --- 4d. Sensor configs (LiDAR, camera) ---
    # Camera configs are scoped to primary packages only — dependency packages
    # (e.g. depthai_ros_driver) include many generic example configs that are not
    # specific to this robot and would create noise in the profile.
    scan_steps.append("sensor_configs")
    lidar_config = _extract_lidar_config(all_yaml_files)
    camera_configs = _extract_camera_configs(primary_yaml_files)

    # --- 4e. Localization + Nav2 ---
    scan_steps.append("nav_config")
    localization_config = _extract_localization_config(all_yaml_files)
    nav2_config = _extract_nav2_config(all_yaml_files)

    # --- 4f. Teleop + e-stop ---
    scan_steps.append("teleop_config")
    teleop_config, estop_config = _extract_teleop_and_estop(all_yaml_files)
    teleop_limits = _extract_teleop_limits(primary_yaml_files)

    # --- 4g. TF frame inventory ---
    scan_steps.append("tf_frames")
    tf_frames = _extract_tf_frames(all_urdf_files, all_yaml_files)

    # --- 4h. Active controllers ---
    scan_steps.append("active_controllers")
    active_controllers = _extract_active_controllers(all_launch_files)

    # --- 4i. Maps, sensor filter pipeline, IMU config, package deps ---
    scan_steps.append("extended_configs")
    maps = _extract_maps(all_yaml_files)
    sensor_filter_pipeline = _extract_sensor_filter_pipeline(all_yaml_files)
    imu_config = _extract_imu_config(hardware_interfaces, all_yaml_files)
    package_dependencies = _extract_package_dependencies(ws_packages)

    # controller_plugins: already collected in ros2_ctrl; expose at top level.
    controller_plugins = ros2_ctrl["controller_plugins"]

    # cmd_vel_topic: prefer teleop config, fall back to ros2_control odom block
    cmd_vel_topic = (teleop_config or {}).get("cmd_vel_topic") or \
                    (ros2_ctrl.get("odom_frame_ids") or {}).get("cmd_vel_topic")

    # --- 5. Sensor / feature detection ---
    scan_steps.append("feature_detection")
    all_pkg_names_lower = [n.lower() for n in (ws_pkg_names + all_ament_pkg_names)]

    has_lidar = any(any(h in p for h in _LIDAR_HINTS) for p in all_pkg_names_lower)
    if not has_lidar:
        has_lidar = _grep_source(all_src_files, list(_LIDAR_HINTS), max_files=40)

    has_camera = any(any(h in p for h in _CAMERA_HINTS) for p in all_pkg_names_lower)
    if not has_camera:
        has_camera = _grep_source(all_src_files, list(_CAMERA_HINTS), max_files=40)

    has_imu = any(any(h in p for h in _IMU_HINTS) for p in all_pkg_names_lower)
    if not has_imu:
        has_imu = _grep_source(all_src_files, list(_IMU_HINTS), max_files=40)

    has_nav2 = any("nav2" in p or "navigation2" in p for p in all_pkg_names_lower)

    # Velocity topic discovery from quoted strings in source files only.
    # Never fall back to assumed defaults — if not found in source, leave empty.
    velocity_topics = []
    for sf in all_src_files[:100]:
        try:
            text = pathlib.Path(sf).read_text(encoding="utf-8", errors="replace")
            for line in text.splitlines():
                m = re.search(r'["\']([/\w]+cmd_vel[/\w]*)["\']', line)
                if m:
                    t = m.group(1)
                    if not t.startswith("/"):
                        t = "/" + t
                    if t not in velocity_topics:
                        velocity_topics.append(t)
        except Exception:
            continue

    # --- 7. Live graph fallback (optional) ---
    live_topics = []
    live_type_map = {}
    if allow_live:
        scan_steps.append("live_graph")
        live_topics, live_type_map = _live_fallback_topics()
        # Refine velocity topics from live graph.
        from ros2_topic import VELOCITY_TYPES
        live_vel_topics = [t for t, typ in live_type_map.items()
                           if typ in VELOCITY_TYPES]
        if live_vel_topics:
            velocity_topics = live_vel_topics

        # Refine sensor presence from live graph.
        topic_str = " ".join(live_topics)
        if not has_lidar:
            has_lidar = any(h in topic_str for h in _LIDAR_HINTS)
        if not has_camera:
            has_camera = any(h in topic_str for h in _CAMERA_HINTS)
        if not has_imu:
            has_imu = any(h in topic_str for h in _IMU_HINTS)
        if not has_nav2:
            has_nav2 = "navigate_to_pose" in topic_str

    # Add teleop-derived cmd_vel_topic to velocity_topics (YAML-sourced, more accurate
    # than source-file regex).  Insert at position 0 so it is the primary topic.
    # Also drop the generic "/cmd_vel" fallback when we have a real YAML-sourced topic.
    if teleop_config:
        tc_topic = teleop_config.get("cmd_vel_topic")
        if isinstance(tc_topic, str) and tc_topic:
            if tc_topic not in velocity_topics:
                velocity_topics.insert(0, tc_topic)
            # The generic fallback "/cmd_vel" was a placeholder; remove it if the real
            # topic is something more specific.
            if tc_topic != "/cmd_vel" and "/cmd_vel" in velocity_topics:
                velocity_topics.remove("/cmd_vel")

    # --- 8. Robot type ---
    # Detection uses PRIMARY workspace packages only — ament-installed
    # infrastructure packages and workspace-local dependency drivers do not
    # characterise the robot's own type.  Using dependency sources here causes
    # false positives (e.g. servo-library words "stance"/"gait" in
    # sts_hardware_interface triggering "legged" for a mobile base robot).
    robot_type, robot_features, robot_type_evidence = _detect_robot_type(
        ws_pkg_names=primary_pkg_names,
        all_src_files=primary_src_files,
        velocity_topics=velocity_topics,
        joint_limits=_flat_joint_limits,
        has_nav2=has_nav2,
        robot_type_override=robot_type_override,
    )

    # Build velocity topic → message type mapping.
    # Priority: teleop YAML interface_type > live graph type map.
    # Never guess — only include topics for which a type was actually found.
    velocity_topic_types: dict = {}
    if teleop_config:
        tc_topic = teleop_config.get("cmd_vel_topic")
        tc_type = teleop_config.get("msg_type")
        if tc_topic and tc_type:
            velocity_topic_types[tc_topic] = tc_type
    for t, tp in live_type_map.items():
        if "cmd_vel" in t.lower() or "vel" in t.lower():
            velocity_topic_types.setdefault(t, tp)
    # Drop any velocity topics for which no type was confirmed.
    velocity_topics = [t for t in velocity_topics if t in velocity_topic_types]

    # --- 9. Safety limits final ---
    # safety_limits has two sections:
    #   sources  — one entry per YAML config that contained at least one limit;
    #              lets the caller see which teleop / planner / controller file
    #              drove each value.
    #   binding  — the most restrictive (minimum) value per axis across all
    #              YAML sources and URDF safety_controller elements; this is
    #              what agents pass to --max-vel / --max-ang.
    safety_limits = {
        "sources": limit_sources,
        "binding": {
            "linear_x": best_lin_x,
            "linear_y": best_lin_y,
            "angular_z": best_ang_z,
        },
    }

    # --- 10. Launch file details (one entry per file, keyed by filename) ---
    launch_file_details = {}
    for lf in all_launch_files:
        key = _make_detail_key(lf, launch_file_details)
        pkg_dir = pathlib.Path(lf).parent.parent  # heuristic: <pkg>/launch/<file>

        # Sub-launch includes and how arguments are forwarded through them.
        includes = _parse_launch_includes(lf)

        # YAML and URDF files co-located with this launch file's package.
        lf_yaml = [
            yf for yf in all_yaml_files
            if pathlib.Path(yf).parent.parent == pkg_dir
        ]
        lf_urdf = [
            uf for uf in all_urdf_files
            if pathlib.Path(uf).parent.parent == pkg_dir
        ]
        # Joint limits per URDF model — same nested structure as the global table.
        lf_joints: dict = {}
        for uf in lf_urdf:
            jl = _extract_joint_limits_from_urdf(uf)
            if jl:
                model_name = _get_urdf_robot_name(uf)
                lf_joints.setdefault(model_name, {}).update(jl)

        # --- Unified launch_args ---
        # AST parse first (works without a live ROS 2 graph): gives default,
        # choices, and description for every DeclareLaunchArgument call.
        arg_meta = _extract_launch_arg_choices(lf)
        # Live parse second (best-effort, requires ros2 CLI): may provide the
        # resolved default when it differs from the literal in the source file.
        live_args = _query_launch_args(lf)
        launch_args = _merge_launch_args(arg_meta, live_args)

        launch_file_details[key] = {
            "path": lf,
            "package": pkg_dir.name,
            "launch_args": launch_args,
            "includes": includes,
            "yaml_files": lf_yaml,
            "urdf_files": lf_urdf,
            "joint_limits": lf_joints,
        }

    # Aggregate launch_configurations: all declared args across all launch files.
    # Source is now the unified launch_args (which includes defaults + choices).
    launch_configurations: dict = {}
    for lf_detail in launch_file_details.values():
        for arg, entry in lf_detail.get("launch_args", {}).items():
            if arg not in launch_configurations:
                launch_configurations[arg] = entry

    # mock_hardware_available: True when any hardware interface declares
    # enable_mock_mode OR any launch arg name suggests mock/sim hardware.
    # Computed here (after launch_configurations is built) so arg names are available.
    mock_hardware_available = bool(
        any(
            str((iface.get("hardware_params") or {}).get("enable_mock_mode", "")).lower()
            in ("true", "1", "yes")
            for iface in hardware_interfaces
        )
        or any(
            "mock" in arg.lower() or "fake" in arg.lower()
            for arg in launch_configurations
        )
    )

    return {
        "scan_steps": scan_steps,
        "ws_packages": ws_pkg_names,
        "ament_packages": all_ament_pkg_names,
        "all_launch_files": all_launch_files,
        "all_urdf_files": primary_urdf_files,
        "launch_file_details": launch_file_details,
        "velocity_topics": velocity_topics,
        "velocity_topic_types": velocity_topic_types,
        "has_lidar": has_lidar,
        "has_camera": has_camera,
        "has_imu": has_imu,
        "has_nav2": has_nav2,
        "robot_type": robot_type,
        "robot_features": robot_features,
        "robot_type_evidence": robot_type_evidence,
        "safety_limits": safety_limits,
        "joint_limits": _resolve_joint_limits(joint_limits_by_model),
        "sensor_mounts": sensor_mounts,
        "live_topics": live_topics,
        # New fields
        "drive_type": ros2_ctrl["drive_type"],
        "kinematics": ros2_ctrl["kinematics"],
        "controller_update_rate_hz": ros2_ctrl["controller_update_rate_hz"],
        "cmd_vel_topic": cmd_vel_topic,
        "odom_frame_ids": ros2_ctrl["odom_frame_ids"],
        "hardware_interfaces": hardware_interfaces,
        "lidar_config": lidar_config,
        "camera_configs": camera_configs,
        "localization_config": localization_config,
        "nav2_config": nav2_config,
        "teleop_config": teleop_config,
        "estop_config": estop_config,
        "teleop_limits": teleop_limits,
        "tf_frames": tf_frames,
        "launch_configurations": launch_configurations,
        "active_controllers": active_controllers,
        # --- Extended config fields ---
        "controller_plugins": controller_plugins,
        "mock_hardware_available": mock_hardware_available,
        "maps": maps,
        "sensor_filter_pipeline": sensor_filter_pipeline,
        "imu_config": imu_config,
        "package_dependencies": package_dependencies,
        # Per-robot scoping
        "pkg_filter": resolved_pkg_filter,
        "matched_dirs": matched_dirs,
        "primary_packages": primary_packages,
        "dependency_packages": dependency_packages,
    }


# ---------------------------------------------------------------------------
# Profile file I/O
# ---------------------------------------------------------------------------

def load_profile_summary():
    """Return the ``summary`` dict of the best available robot profile, or ``None``.

    This is the **public entry point** for other skill modules that want to
    read profile context before executing a command.  It is intentionally
    silent — it never writes to stdout, never raises, and never blocks.

    Selection strategy (first match wins):
    1. The single profile in ``.profiles/`` when there is exactly one.
    2. The most recently *modified* profile when there are several.

    Returns ``None`` when:
    - No profile has been scanned yet (no ``.profiles/`` directory or no JSON
      files inside it).
    - The profile file cannot be read or parsed.
    """
    try:
        if not _PROFILES_DIR.exists():
            return None
        profiles = sorted(_PROFILES_DIR.glob("*_profile.json"))
        if not profiles:
            return None
        # Prefer single profile; otherwise pick the most recently written one.
        chosen = profiles[0] if len(profiles) == 1 \
            else max(profiles, key=lambda p: p.stat().st_mtime)
        data = json.loads(chosen.read_text(encoding="utf-8"))
        return data.get("summary")
    except Exception:
        return None


def _profile_path(name="robot"):
    """Return the absolute path for a named robot's profile JSON."""
    _PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^\w\-]", "_", name.lower())
    return _PROFILES_DIR / f"{safe_name}_profile.json"


def _load_profile(name="robot"):
    """Load and return the profile dict, or None if it doesn't exist."""
    p = _profile_path(name)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_profile(profile, name="robot"):
    """Write the profile dict to disk as JSON."""
    p = _profile_path(name)
    p.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding="utf-8")
    return str(p)


def _strip_nulls(obj):
    """Recursively remove absent values from a dict or list.

    A value is considered *absent* when it is:
    - ``None``
    - An empty list ``[]``
    - An empty dict ``{}``

    ``False`` and ``0`` are **kept** — they are valid, informative values.
    Applied to the profile summary so agents never see ``null`` / empty
    fields; a missing key unambiguously means "not detected / not applicable".
    """
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            sv = _strip_nulls(v)
            if sv is None or sv == [] or sv == {}:
                continue
            result[k] = sv
        return result
    if isinstance(obj, list):
        return [_strip_nulls(item) for item in obj]
    return obj


def _build_profile(robot_name, workspace, distro, scan_result):
    """Assemble the final tiered profile dict from a scan result."""
    sr = scan_result
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "robot_name": robot_name,
        "workspace": workspace,
        "ros_distro": distro,
        # pkg_filter: patterns used to scope the scan to a specific robot's
        # packages (e.g. ["lekiwi"]).  Stored here so rescan can reuse it
        # without the user having to repeat --packages on every rescan.
        # Empty list means the full workspace was scanned.
        "pkg_filter": sr.get("pkg_filter", []),
        # primary_packages: names scanned fully (URDFs, launch files, YAML, src).
        # dependency_packages: workspace-local deps of primary packages; scanned
        # for YAML configs and source only (no launch files, no URDFs).
        "primary_packages": sr.get("primary_packages", []),
        "dependency_packages": sr.get("dependency_packages", []),
        "scan_steps": sr["scan_steps"],
        # ------------------------------------------------------------------ #
        # SUMMARY — always loaded; compact; one-glance robot overview.        #
        # ------------------------------------------------------------------ #
        # _strip_nulls removes every key whose value is None, [], or {} so   #
        # that agents never encounter null fields — a missing key means       #
        # "not detected / not applicable".  False and 0 are preserved.       #
        "summary": _strip_nulls({
            "robot_type": sr["robot_type"],
            # robot_features: supplementary capabilities alongside the primary type.
            # e.g. ["pantilt"] for a mobile_base with a pan-tilt head.
            "robot_features": sr["robot_features"],
            # robot_type_evidence: signals that drove the detected type.
            # Each key is a type/feature label; value is a list of signal strings.
            "robot_type_evidence": sr["robot_type_evidence"],
            "packages": sr["ws_packages"],
            # launch_files: the filenames as they exist in the workspace.
            # Each entry is a key into the detail section.
            "launch_files": sorted(sr["launch_file_details"].keys()),
            "urdf_files": sr["all_urdf_files"],
            "velocity_topics": [
                {"topic": t, "type": sr["velocity_topic_types"][t]}
                for t in sr["velocity_topics"]
                if t in sr.get("velocity_topic_types", {})
            ],
            "has_lidar": sr["has_lidar"],
            "has_camera": sr["has_camera"],
            "has_imu": sr["has_imu"],
            "has_nav2": sr["has_nav2"],
            "safety_limits": sr["safety_limits"],
            # joint_limits: {model_name: {joint_name: {velocity, effort, type}}}
            # Keyed by the <robot name="…"> from each URDF so example or test
            # URDFs in the workspace are clearly separated from the main robot.
            "joint_limits": sr["joint_limits"],
            # sensor_mounts: one entry per sensor/actuator link found in URDF.
            # Stores the physical xyz position and rpy orientation of each
            # sensor relative to its parent link.  Visual sensors
            # (camera, depth_camera) also carry image_rotation_deg — the
            # suggested correction to apply when capturing images.
            "sensor_mounts": sr["sensor_mounts"],
            # ---- Drive / kinematics ----------------------------------------
            # drive_type: detected from ros2_control controller plugin name.
            # One of: differential, holonomic_omni, mecanum, ackermann,
            # bicycle, tricycle, or null when not detectable.
            "drive_type": sr["drive_type"],
            # kinematics: geometry params from controller ros__parameters
            # (wheel_radius, robot_radius, wheel_separation, etc.)
            "kinematics": sr["kinematics"],
            "controller_update_rate_hz": sr["controller_update_rate_hz"],
            # cmd_vel_topic: actual topic the base controller subscribes to.
            # Derived from teleop YAML topic_name (preferred) or controller params.
            "cmd_vel_topic": sr["cmd_vel_topic"],
            # odom_frame_ids: {odom_topic, base_frame_id, odom_frame_id}
            # from the controller's ros__parameters block.
            "odom_frame_ids": sr["odom_frame_ids"],
            # ---- Hardware --------------------------------------------------
            # hardware_interfaces: one entry per <ros2_control> URDF tag.
            # Each entry has plugin, type, joints, command/state interfaces,
            # and hardware params (serial port, baud rate, I2C address, etc.)
            "hardware_interfaces": sr["hardware_interfaces"],
            # ---- Sensors ---------------------------------------------------
            "lidar_config": sr["lidar_config"],
            "camera_configs": sr["camera_configs"],
            # ---- Navigation ------------------------------------------------
            "localization_config": sr["localization_config"],
            "nav2_config": sr["nav2_config"],
            # ---- Teleop / e-stop -------------------------------------------
            "teleop_config": sr["teleop_config"],
            "estop_config": sr["estop_config"],
            # teleop_limits: per-axis velocity scales from teleop YAML files.
            # Mirrors safety_limits structure: sources (one per file) + binding
            # (minimum across all teleop configs).  The binding values are the
            # maximum velocities the joystick can command at full deflection.
            "teleop_limits": sr.get("teleop_limits"),
            # ---- TF frames -------------------------------------------------
            # tf_frames: {urdf_links: [...], map_frame, odom_frame, base_frame}
            "tf_frames": sr["tf_frames"],
            # ---- Launch ----------------------------------------------------
            # launch_configurations: args with declared choices across all
            # launch files — tells the agent which variants can be launched
            # (e.g. config:=base|pantilt|k2)
            "launch_configurations": sr["launch_configurations"],
            # active_controllers: unique controller names spawned by any
            # launch file in the workspace.
            "active_controllers": sr["active_controllers"],
            # ---- Extended config fields ------------------------------------
            # controller_plugins: full plugin type strings declared under
            # controller_manager.ros__parameters in any ros2_control YAML.
            # These are the raw plugin identifiers (e.g.
            # "diff_drive_controller/DiffDriveController") from which
            # active_controllers and drive_type are derived.
            "controller_plugins": sr["controller_plugins"],
            # mock_hardware_available: True when any ros2_control hardware
            # interface declares enable_mock_mode=true, or when any launch
            # file exposes a "mock" / "fake" launch argument.
            "mock_hardware_available": sr["mock_hardware_available"],
            # maps: nav2 map-server YAMLs found in the workspace.  Each entry
            # carries {file, path, name, type, resolution, image}.
            # type is one of: "occupancy" | "keepout" | "speed".
            "maps": sr["maps"],
            # sensor_filter_pipeline: filter chain entries extracted from
            # laser_filters / sensor_filters YAML files.
            # Each entry: {name, type, source_file, params?}
            "sensor_filter_pipeline": sr["sensor_filter_pipeline"],
            # imu_config: IMU hardware plugin, state_interfaces, hardware
            # params, and broadcaster/filter node config.
            "imu_config": sr["imu_config"],
            # package_dependencies: {pkg_name: [exec_depend, ...]} for each
            # primary package.  Derived from package.xml exec_depend tags;
            # useful for understanding runtime requirements at a glance.
            "package_dependencies": sr["package_dependencies"],
        }),
        # ------------------------------------------------------------------ #
        # DETAIL — per launch file; load on demand via --section <filename>.  #
        # Same null-stripping as summary: absent key = nothing found.         #
        # ------------------------------------------------------------------ #
        "detail": _strip_nulls(sr["launch_file_details"]),
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_profile_scan(args):
    """Scan the robot workspace and write a robot profile JSON."""
    user_ws = getattr(args, "workspace", None)
    explicit_name = getattr(args, "name", None)  # None when --name was not given
    robot_name = explicit_name or "robot"
    allow_live = getattr(args, "allow_live", False)
    robot_type_override = getattr(args, "robot_type", None)
    pkg_filter = getattr(args, "packages", None)

    # Auto-scope: if --name was given but --packages was not, derive the package
    # filter from the robot name.  This ensures "profile scan --name lekiwi"
    # never silently scans the entire workspace.
    if pkg_filter is None and explicit_name:
        pkg_filter = explicit_name

    if robot_type_override and robot_type_override not in _VALID_ROBOT_TYPES:
        output({
            "error": f"Invalid --robot-type '{robot_type_override}'.",
            "valid_types": sorted(_VALID_ROBOT_TYPES),
        })
        return

    distro = os.environ.get("ROS_DISTRO", "unknown")

    # --- Workspace discovery ---
    ws_path, ws_status = _discover_workspace(user_ws)

    if ws_status == "not_found" and not allow_live:
        output({
            "error": (
                "No ROS 2 workspace found. "
                "Pass --workspace /path/to/ws or set ROS2_LOCAL_WS, "
                "or use --allow-live to fall back to the live graph."
            ),
            "searched": [c for c in _WS_CANDIDATES if c],
        })
        return

    # --- Run scan ---
    scan_result = _run_static_scan(
        ws_path=ws_path,
        distro=distro,
        allow_live=allow_live,
        robot_type_override=robot_type_override,
        pkg_filter=pkg_filter,
    )

    # --- Derive robot name ---
    # If --packages was given and no --name provided, derive from the first pattern.
    if robot_name == "robot":
        if pkg_filter:
            patterns = _parse_pkg_filter(pkg_filter)
            if patterns:
                robot_name = patterns[0]
        elif ws_path:
            derived = pathlib.Path(ws_path).name
            derived = re.sub(r"(?:_ws|_ros2|ros2_|_robot)$", "", derived, flags=re.I)
            if derived and derived != "robot":
                robot_name = derived

    # --- Build and save profile ---
    profile = _build_profile(
        robot_name=robot_name,
        workspace=ws_path or "",
        distro=distro,
        scan_result=scan_result,
    )
    profile_file = _save_profile(profile, name=robot_name)

    output({
        "success": True,
        "robot_name": robot_name,
        "profile_file": profile_file,
        "workspace": ws_path,
        "workspace_status": ws_status,
        "pkg_filter": scan_result["pkg_filter"],
        "primary_packages": scan_result["primary_packages"],
        "dependency_packages": scan_result["dependency_packages"],
        "matched_dirs": scan_result["matched_dirs"],
        "launch_files_found": sorted(scan_result["launch_file_details"].keys()),
        "packages_found": len(scan_result["ws_packages"]),
        "packages_scanned": scan_result["ws_packages"],
        "robot_type": scan_result["robot_type"],
        "robot_features": scan_result["robot_features"],
        "robot_type_evidence": scan_result["robot_type_evidence"],
        "sensor_mounts": scan_result["sensor_mounts"],
        "safety_limits": scan_result["safety_limits"],
        "scan_steps": scan_result["scan_steps"],
        "summary": profile["summary"],
    })


def cmd_profile_show(args):
    """Show the current robot profile (or a specific section)."""
    robot_name = getattr(args, "name", None) or "robot"
    section = getattr(args, "section", None)

    # Try to infer robot name if 'robot' and a profile exists.
    if robot_name == "robot":
        if _PROFILES_DIR.exists():
            profiles = sorted(_PROFILES_DIR.glob("*_profile.json"))
            if len(profiles) == 1:
                stem = profiles[0].name.replace("_profile.json", "")
                robot_name = stem

    profile = _load_profile(robot_name)
    if profile is None:
        output({
            "error": f"No profile found for robot '{robot_name}'.",
            "hint": "Run: python3 ros2_cli.py profile scan [--workspace PATH]",
            "profiles_dir": str(_PROFILES_DIR),
        })
        return

    if section:
        if section == "summary":
            output({"robot_name": robot_name, "summary": profile.get("summary", {})})
        elif section == "detail":
            output({"robot_name": robot_name, "detail": profile.get("detail", {})})
        elif section in profile.get("detail", {}):
            output({"robot_name": robot_name, "launch_file": section,
                    "detail": profile["detail"][section]})
        else:
            available = ["summary", "detail"] + list(profile.get("detail", {}).keys())
            output({
                "error": f"Section '{section}' not found.",
                "available_sections": available,
            })
    else:
        # Default: show summary + annotations + list of available detail sections.
        summary = profile.get("summary", {}) or {}
        out = {
            "robot_name": robot_name,
            "generated_at": profile.get("generated_at"),
            "workspace": profile.get("workspace"),
            "ros_distro": profile.get("ros_distro"),
            "summary": summary,
            # annotations: free-text notes added by the user via 'profile annotate'.
            # Always included so agents see them at session-start without an extra call.
            "annotations": profile.get("annotations", []),
            "detail_sections": list(profile.get("detail", {}).keys()),
            "hint": "Use --section <launch-filename> to load a launch file's full detail.",
        }
        # When a usable summary is loaded, attach a Path A reminder so the
        # agent sees the operational rules at the exact moment it learns the
        # profile exists. This is the structural counterpart to the textual
        # Path A guards in SKILL.md / RULES-CORE.md / RULES-MOTION.md.
        if isinstance(summary, dict) and summary:
            out["path_a_reminder"] = build_path_a_reminder(summary)
        output(out)


def cmd_profile_annotate(args):
    """Append a free-text annotation to the current robot profile.

    Annotations are stored persistently alongside the profile and are
    returned by every ``profile show`` call.  They are intended for
    information that cannot be auto-detected from the workspace — e.g.
    hardware quirks, known sensor calibration issues, or operational
    constraints that the agent must know about:

        profile annotate "Left motor encoder is worn — odometry drifts right.
                         Apply a slight left correction to cmd_vel."

        profile annotate "Camera image is horizontally mirrored because it
                         faces a reflective surface."

    Agents MUST read and apply annotations when executing commands —
    they are treated as mandatory operational context, not optional hints.
    """
    text = getattr(args, "text", None)
    if not text or not text.strip():
        output({"error": "Annotation text cannot be empty."})
        return

    robot_name = getattr(args, "name", None) or "robot"

    # Auto-detect profile if name not provided.
    existing = _load_profile(robot_name)
    if existing is None:
        if _PROFILES_DIR.exists():
            profiles = sorted(_PROFILES_DIR.glob("*_profile.json"))
            if len(profiles) == 1:
                robot_name = profiles[0].name.replace("_profile.json", "")
                existing = _load_profile(robot_name)

    if existing is None:
        output({
            "error": "No profile found to annotate.",
            "hint": "Run: python3 ros2_cli.py profile scan [--workspace PATH]",
        })
        return

    annotation = {
        "added_at": datetime.now(timezone.utc).isoformat(),
        "note": text.strip(),
    }
    existing.setdefault("annotations", []).append(annotation)
    _save_profile(existing, name=robot_name)

    output({
        "success": True,
        "robot_name": robot_name,
        "annotation_index": len(existing["annotations"]) - 1,
        "annotation": annotation,
        "total_annotations": len(existing["annotations"]),
        "hint": "Run 'profile show' to see all annotations.",
    })


def cmd_profile_rescan(args):
    """Rescan the robot workspace, updating the profile.

    With --launch-file FILENAME, rescans only that launch file's args
    (fast partial rescan).  Without it, performs a full rescan.
    Pass --robot-type TYPE on a full rescan to override the detected type.
    Pass --packages PATTERNS to change (or clear) the package filter used for
    the original scan; omit it to reuse the filter stored in the profile.
    If --name is given but --packages is not, the package filter is automatically
    derived from the name (same auto-scope as profile scan).
    """
    explicit_name = getattr(args, "name", None)  # None when --name was not given
    robot_name = explicit_name or "robot"
    launch_filter = getattr(args, "launch_file", None)
    user_ws = getattr(args, "workspace", None)
    allow_live = getattr(args, "allow_live", False)
    pkg_filter_override = getattr(args, "packages", None)

    existing = _load_profile(robot_name)
    if existing is None:
        # Try to infer from whatever profile exists.
        if _PROFILES_DIR.exists():
            profiles = sorted(_PROFILES_DIR.glob("*_profile.json"))
            if len(profiles) == 1:
                robot_name = profiles[0].name.replace("_profile.json", "")
                existing = _load_profile(robot_name)

    if launch_filter and existing:
        # Partial rescan: re-query launch args for the specified launch file.
        detail = existing.get("detail", {})
        if launch_filter not in detail:
            output({
                "error": f"Launch file '{launch_filter}' not found in existing profile.",
                "available": list(detail.keys()),
            })
            return
        lf = detail[launch_filter].get("path", "")
        new_args = _query_launch_args(lf) if lf else {}
        new_includes = _parse_launch_includes(lf) if lf else []
        detail[launch_filter]["launch_args"] = new_args
        detail[launch_filter]["includes"] = new_includes
        existing["detail"] = detail
        existing["generated_at"] = datetime.now(timezone.utc).isoformat()
        profile_file = _save_profile(existing, name=robot_name)
        output({
            "success": True,
            "mode": "partial",
            "launch_file": launch_filter,
            "profile_file": profile_file,
            "launch_args": new_args,
            "includes": new_includes,
        })
        return

    # Full rescan — delegate to scan.
    # Preserve any user-added annotations so they survive the rescan.
    preserved_annotations = (existing or {}).get("annotations", [])

    args.name = robot_name
    if user_ws is None and existing:
        # Re-use the workspace from the existing profile.
        args.workspace = existing.get("workspace") or None

    # Restore stored pkg_filter unless the user explicitly passed --packages.
    if pkg_filter_override is None and existing:
        stored = existing.get("pkg_filter")
        if stored:
            # stored is already a list of patterns; join for uniform handling.
            args.packages = ",".join(stored)
        elif explicit_name:
            # Stored filter is empty; auto-derive from the robot name to avoid
            # producing a full-workspace rescan.
            args.packages = explicit_name
    elif pkg_filter_override is None and explicit_name:
        # No existing profile yet; auto-derive from name.
        args.packages = explicit_name

    cmd_profile_scan(args)

    # Re-inject annotations into the freshly written profile (if any exist).
    if preserved_annotations:
        refreshed = _load_profile(robot_name)
        if refreshed is not None:
            refreshed["annotations"] = preserved_annotations
            _save_profile(refreshed, name=robot_name)


def cmd_profile_list(args):
    """List all robot profiles stored in .profiles/."""
    if not _PROFILES_DIR.exists():
        output({"profiles": [], "profiles_dir": str(_PROFILES_DIR)})
        return

    profiles = []
    for p in sorted(_PROFILES_DIR.glob("*_profile.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            profiles.append({
                "file": str(p),
                "robot_name": data.get("robot_name", p.stem),
                "generated_at": data.get("generated_at"),
                "ros_distro": data.get("ros_distro"),
                "robot_type": data.get("summary", {}).get("robot_type"),
                "launch_files": data.get("summary", {}).get("launch_files", []),
            })
        except Exception:
            profiles.append({"file": str(p), "error": "Could not parse profile"})

    output({"profiles": profiles, "total": len(profiles),
            "profiles_dir": str(_PROFILES_DIR)})


# ---------------------------------------------------------------------------
# Path A guards
# ---------------------------------------------------------------------------
#
# These helpers implement the structural counterpart to the textual Path A
# rules in SKILL.md / RULES-CORE.md Rule 14 / RULES-MOTION.md Rule 3. When a
# profile is loaded, the agent is forbidden from running live-discovery
# commands for data the profile already holds. The text rules describe the
# violation; these helpers make it observable in the JSON output of the
# offending command itself, at the moment of invocation, so the agent learns
# the correct profile field name even when the text rules fail to land.
#
# The guards are *advisory by default* (the helper returns a non-None dict
# which the caller turns into a refusal). Callers also accept --ignore-profile
# to fall back to the live behaviour for legitimate Path B / debug needs.

def build_path_a_reminder(summary):
    """Build the path_a_reminder block included in 'profile show' output.

    Lists, for each profile-covered field, the live-discovery command that is
    forbidden when this profile is loaded, and the profile field the agent
    should read instead.
    """
    fused = (summary.get("localization_config") or {}).get("fused_sources") or {}
    odom_topic = next(iter(fused.values()), None) if isinstance(fused, dict) else None
    vel_topics = summary.get("velocity_topics") or []
    vel_type = vel_topics[0].get("type") if vel_topics else None
    estop = summary.get("estop_config") or {}
    tf = summary.get("tf_frames") or {}
    limits = (summary.get("safety_limits") or {}).get("binding") or {}

    forbidden = []
    if summary.get("cmd_vel_topic"):
        forbidden.append({
            "forbidden_command": "topics find geometry_msgs/msg/Twist",
            "also_forbidden": "topics find geometry_msgs/msg/TwistStamped",
            "use_instead": "summary.cmd_vel_topic",
            "current_value": summary.get("cmd_vel_topic"),
        })
    if vel_type:
        forbidden.append({
            "forbidden_command": f"topics type {summary.get('cmd_vel_topic')}",
            "use_instead": "summary.velocity_topics[0].type",
            "current_value": vel_type,
        })
    if odom_topic:
        forbidden.append({
            "forbidden_command": "topics find nav_msgs/msg/Odometry",
            "use_instead": "summary.localization_config.fused_sources",
            "current_value": odom_topic,
        })
    if limits:
        forbidden.append({
            "forbidden_command": "params list <each-node> + grep max|limit|vel|speed|accel",
            "use_instead": "summary.safety_limits.binding",
            "current_value": limits,
        })
    if tf.get("odom_frame") or tf.get("base_frame") or tf.get("map_frame"):
        forbidden.append({
            "forbidden_command": "tf list (to discover frame names)",
            "use_instead": "summary.tf_frames",
            "current_value": {
                "odom_frame": tf.get("odom_frame"),
                "base_frame": tf.get("base_frame"),
                "map_frame": tf.get("map_frame"),
            },
        })
    if estop.get("service_name"):
        forbidden.append({
            "forbidden_command": "services find std_srvs/srv/SetBool",
            "use_instead": "summary.estop_config.service_name",
            "current_value": estop.get("service_name"),
        })
    if summary.get("active_controllers"):
        forbidden.append({
            "forbidden_command": "control list-controllers (to *discover* controller names)",
            "use_instead": "summary.active_controllers",
            "current_value": summary.get("active_controllers"),
            "note": "Running control list-controllers to *verify* runtime "
                    "active/inactive state of a controller named in the profile "
                    "is allowed — and required before motion.",
        })

    allowed_live_calls_before_motion = [
        "control list-controllers (verify the profile-named controller is active)",
        "topics subscribe <ODOM_TOPIC> --max-messages 1 --timeout 2 (stationary check + odom liveness)",
        "interface proto <VEL_TYPE> (payload template, once per session)",
        "topics hz <ODOM_TOPIC> --duration 2 (only if odom rate is not yet known)",
    ]

    return {
        "path": "A",
        "decision_rule": (
            "Is this field present in the profile? "
            "yes -> use it (no live call); "
            "no -> fall back to live for that one field only (Rule 0.0a); "
            "disagrees with live graph -> stop and escalate (Rule 0.0b). "
            "The path does not flip."
        ),
        "forbidden_in_path_a": forbidden,
        "allowed_live_calls_before_motion": allowed_live_calls_before_motion,
        "violated_rule_if_ignored": "RULES-CORE.md Rule 14 (Path A antipatterns); "
                                    "RULES-MOTION.md Rule 3 Step 1.",
        "override_flag": "Pass --ignore-profile to a guarded command (topics find, "
                         "services find) if you need to run it for legitimate "
                         "Path B / debug reasons. This is logged in the output.",
    }


# Message type prefixes that have profile-covered fields. Both '/msg/' and
# unqualified forms are accepted because ros2 CLI accepts both.
_NORM_MSG = lambda t: re.sub(r"/msg/", "/", t or "")
_NORM_SRV = lambda t: re.sub(r"/srv/", "/", t or "")

# ---------------------------------------------------------------------------
# Dynamic type extractors – read types from the profile itself so that new
# drive/service types are covered automatically without any code changes.
# ---------------------------------------------------------------------------


def _get_velocity_types(summary: dict) -> set:
    """Return normalised message types that map to velocity (cmd_vel) topics.

    Baseline always includes geometry_msgs/Twist and TwistStamped.
    Types listed in summary.velocity_topics[].type are added dynamically, so
    robots using TwistWithCovarianceStamped or custom types are covered the
    moment those types appear in the profile.
    """
    types = {"geometry_msgs/Twist", "geometry_msgs/TwistStamped"}
    for entry in summary.get("velocity_topics") or []:
        if entry.get("type"):
            types.add(_NORM_MSG(entry["type"]))
    return types


def _get_estop_types(summary: dict) -> set:
    """Return normalised service types that map to the e-stop service.

    Baseline always includes std_srvs/SetBool.
    If the profile carries a specific service_type it is added dynamically.
    """
    types = {"std_srvs/SetBool"}
    stype = (summary.get("estop_config") or {}).get("service_type", "")
    if stype:
        types.add(_NORM_SRV(stype))
    return types


# ---------------------------------------------------------------------------
# Declarative guard tables
#
# Each entry describes one profile coverage rule:
#   profile_field  – dotted path shown in violation messages
#   present_fn     – callable(summary) → truthy when the profile has this value
#   match_fn       – callable(target_type, summary) → True when the requested
#                    type is covered by this guard
#   value_fn       – callable(summary) → the profile value to show
#   extra_fn       – optional callable(summary) → dict merged into violation
# ---------------------------------------------------------------------------

_TOPICS_FIND_GUARDS = [
    {
        "profile_field": "summary.cmd_vel_topic",
        "present_fn": lambda s: s.get("cmd_vel_topic"),
        # Exact-set match using dynamically-built type set from the profile.
        "match_fn": lambda t, s: t in _get_velocity_types(s),
        "value_fn": lambda s: s.get("cmd_vel_topic"),
        "extra_fn": lambda s: {
            "velocity_topics": s.get("velocity_topics"),
            "note": (
                "Read summary.cmd_vel_topic for the topic name and "
                "summary.velocity_topics[0].type for the message type. "
                "Both are profile-covered."
            ),
        },
    },
    {
        "profile_field": "summary.localization_config.fused_sources",
        "present_fn": lambda s: (s.get("localization_config") or {}).get("fused_sources"),
        # Substring match: covers nav_msgs/Odometry, OdometryWithCovarianceStamped,
        # nav2_msgs/ParticleCloud (which wraps odometry), and any future odometry
        # variants without needing new entries.
        "match_fn": lambda t, _s: "odometry" in t.lower(),
        "value_fn": lambda s: (s.get("localization_config") or {}).get("fused_sources"),
    },
]

_SERVICES_FIND_GUARDS = [
    {
        "profile_field": "summary.estop_config.service_name",
        "present_fn": lambda s: (s.get("estop_config") or {}).get("service_name"),
        # Exact-set match using dynamically-built type set from the profile.
        "match_fn": lambda t, s: t in _get_estop_types(s),
        "value_fn": lambda s: (s.get("estop_config") or {}).get("service_name"),
        "extra_fn": lambda s: {
            "service_type": (s.get("estop_config") or {}).get("service_type"),
            "note": (
                "Read summary.estop_config.service_name for the e-stop "
                "service. Other services of this type in the system are not "
                "the e-stop — if you genuinely need to enumerate them, "
                "pass --ignore-profile."
            ),
        },
    },
]


def check_topics_find_path_a(msg_type: str, summary: dict):
    """Return a violation dict if 'topics find <msg_type>' is a Path A violation.

    Iterates the declarative _TOPICS_FIND_GUARDS table so that adding a new
    covered field requires only a new table entry, not a code change here.
    Returns None when the call is allowed (no matching profile coverage).
    """
    if not isinstance(summary, dict) or not summary:
        return None
    target = _NORM_MSG(msg_type)
    for guard in _TOPICS_FIND_GUARDS:
        if guard["present_fn"](summary) and guard["match_fn"](target, summary):
            extra = guard.get("extra_fn", lambda _: {})(summary) or None
            return _violation(
                command=f"topics find {msg_type}",
                field=guard["profile_field"],
                value=guard["value_fn"](summary),
                extra=extra,
            )
    return None


def check_services_find_path_a(srv_type: str, summary: dict):
    """Return a violation dict if 'services find <srv_type>' is a Path A violation.

    Iterates the declarative _SERVICES_FIND_GUARDS table.
    Returns None when the call is allowed (no matching profile coverage).
    """
    if not isinstance(summary, dict) or not summary:
        return None
    target = _NORM_SRV(srv_type)
    for guard in _SERVICES_FIND_GUARDS:
        if guard["present_fn"](summary) and guard["match_fn"](target, summary):
            extra = guard.get("extra_fn", lambda _: {})(summary) or None
            return _violation(
                command=f"services find {srv_type}",
                field=guard["profile_field"],
                value=guard["value_fn"](summary),
                extra=extra,
            )
    return None


def _violation(command, field, value, extra=None):
    """Construct the violation JSON payload."""
    out = {
        "error": "path_a_violation",
        "message": (
            f"Refused: '{command}' is a Path A violation. The profile already "
            f"has this value at '{field}'. Read it from 'profile show' "
            "instead of running live discovery."
        ),
        "profile_field": field,
        "profile_value": value,
        "violated_rule": "RULES-CORE.md Rule 14 (Path A antipatterns); "
                         "RULES-MOTION.md Rule 3 Step 1.",
        "remedy": "Use the profile field shown above. The path does not flip "
                  "to live discovery just because you ran this command.",
        "override": "Pass --ignore-profile to run the live discovery anyway "
                    "(legitimate Path B / debug uses only).",
    }
    if extra:
        out.update(extra)
    return out


if __name__ == "__main__":
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

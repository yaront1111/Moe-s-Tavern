# ROS 2 Skill — CLI Reference

> **Note:** The CLI is intended for debugging and development only. Normal usage is through the chat interface or messaging gateway of your AI agent platform (e.g. nanobot, OpenClaw) — not by running `ros2_cli.py` directly.

## Quick Start

```bash
# Source ROS 2 environment
source /opt/ros/${ROS_DISTRO}/setup.bash

# Run commands
python3 scripts/ros2_cli.py version
python3 scripts/ros2_cli.py topics list
python3 scripts/ros2_cli.py nodes list

# Move robot forward for 3 seconds
python3 scripts/ros2_cli.py topics publish /cmd_vel \
  '{"linear":{"x":1.0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' --duration 3

# Read sensor data
python3 scripts/ros2_cli.py topics subscribe /scan --duration 3
```

All commands output JSON. See [`COMMANDS.md`](COMMANDS.md) for the full reference with output examples.

---

## Supported Commands

| Category | Commands |
| -------- | -------- |
| Connection | `version` |
| Topics | `list`, `type`, `details`, `message`, `subscribe`, `publish`, `publish-sequence`, `publish-until`, `hz`, `bw`, `delay`, `find`, `capture-image`, `diag-list`, `diag`, `battery-list`, `battery`, `qos-check` |
| Services | `list`, `type`, `details`, `call`, `find`, `echo` |
| Nodes | `list`, `details` |
| Parameters | `list`, `get`, `set`, `describe`, `dump`, `load`, `delete`, `preset-save`, `preset-load`, `preset-list`, `preset-delete`, `find` |
| Actions | `list`, `details`, `type`, `send`, `cancel`, `echo`, `find` |
| Lifecycle | `nodes`, `list`, `get`, `set` |
| Control | `list-controller-types`, `list-controllers`, `list-hardware-components`, `list-hardware-interfaces`, `load-controller`, `unload-controller`, `configure-controller`, `reload-controller-libraries`, `set-controller-state`, `set-hardware-component-state`, `switch-controllers`, `view-controller-chains` |
| TF | `list`, `lookup`, `echo`, `monitor`, `static`, `euler-from-quaternion`, `quaternion-from-euler`, `transform-point`, `transform-vector`, `tree`, `validate` |
| Doctor | `check`, `hello` |
| Multicast | `send`, `receive` |
| Interface | `list`, `show`, `proto`, `packages`, `package` |
| Bag | `info` |
| Component | `types`, `list`, `ls`, `load`, `unload`, `kill`, `standalone` |
| Pkg | `list`, `prefix`, `executables`, `xml` |
| Daemon | `status`, `start`, `stop` |
| Launch | `new`, `list`, `kill`, `restart`, `foxglove` |
| Run | `new`, `list`, `kill`, `restart` |
| Emergency Stop | `estop` |

---

## Agent Features

Capabilities beyond standard `ros2` CLI parity — designed specifically for AI agents operating on mobile robots:

| Feature | Command(s) | Description |
|---------|------------|-------------|
| **Emergency stop** | `estop` | Send zero-velocity command to halt mobile robots safely |
| **Publish sequence** | `topics publish-sequence` | Publish a timed sequence of different messages in one call |
| **Publish-until** | `topics publish-until` | Publish repeatedly and stop automatically when a condition is met (supports Euclidean distance and rotation) |
| **Topic rate / bandwidth** | `topics hz`, `topics bw`, `topics delay` | Monitor publish rate, bandwidth, and message delay for any topic |
| **QoS compatibility check** | `topics qos-check` | Compare publisher and subscriber QoS profiles; suggests fix flags for mismatches |
| **Image capture** | `topics capture-image` | Grab a frame from any ROS 2 image topic and save to `.artifacts/` |
| **Diagnostics monitoring** | `topics diag-list`, `topics diag` | Discover and read `DiagnosticArray` topics by type, with human-readable level names |
| **Battery monitoring** | `topics battery-list`, `topics battery` | Discover and read `BatteryState` topics by type, with decoded status, health, and technology names |
| **Parameter search** | `params find` | Search all live nodes for parameters matching a substring |
| **Parameter presets** | `params preset-save/load/list/delete` | Save and restore complete parameter sets for a node by name |
| **TF graph tools** | `tf tree`, `tf validate` | Visualise the full TF frame hierarchy; detect cycles and multiple-parent errors |
| **Launch files** | `launch new/list/kill/restart/foxglove` | Run launch files in tmux sessions, list/kill/restart running sessions, launch foxglove_bridge |
| **Run executables** | `run new/list/kill/restart` | Run executables in tmux sessions, list/kill/restart running sessions |
| **Discord integration** | `discord_tools.py send-image` | Send images (or PDFs) to a Discord channel via bot token |

---

## Global Options

Place these **before** the command name to apply a setting to all commands:

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | per-command default | Override the per-command timeout (useful for slow networks) |
| `--retries N` | `1` | Total attempts before giving up; `1` = no retry |

```bash
python3 scripts/ros2_cli.py --timeout 30 --retries 3 lifecycle get /camera_driver
```

See [`EXAMPLES.md`](EXAMPLES.md) for practical usage examples including image capture and Discord integration.

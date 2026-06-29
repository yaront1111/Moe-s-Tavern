# ROS 2 Skill

![Status](https://img.shields.io/badge/Status-Active-green) [![Repo](https://img.shields.io/badge/Repo-adityakamath%2Fros2--skill-purple?style=flat&logo=github&logoSize=auto)](https://github.com/adityakamath/ros2-skill) [![Blog](https://img.shields.io/badge/Blog-kamathrobotics.com-darkorange?style=flat&logo=hashnode&logoSize=auto)](https://kamathrobotics.com) [![Ask DeepWiki (Experimental)](https://deepwiki.com/badge.svg)](https://deepwiki.com/adityakamath/ros2-skill) ![Python](https://img.shields.io/badge/python-3.10%2B-blue?style=flat&logo=python&logoColor=white) ![Static Badge](https://img.shields.io/badge/License-Apache%202.0-blue)

[![SKILL.md](https://img.shields.io/badge/docs-SKILL.md-green)](SKILL.md) [![AGENTS.md](https://img.shields.io/badge/docs-AGENTS.md-green)](AGENTS.md) [![RULES.md](https://img.shields.io/badge/docs-RULES.md-7aab8a)](references/RULES.md) [![COMMANDS.md](https://img.shields.io/badge/docs-COMMANDS.md-7aab8a)](references/COMMANDS.md) [![EXAMPLES.md](https://img.shields.io/badge/docs-EXAMPLES.md-7aab8a)](references/EXAMPLES.md) [![CLI.md](https://img.shields.io/badge/docs-CLI.md-7aab8a)](references/CLI.md)

[Agent Skill](https://agentskills.io) for ROS 2 robot control via rclpy.

```text
Agent (LLM) → ros2_cli.py → rclpy → ROS 2
```

## Overview

An AI agent skill that lets agents control ROS 2 robots through natural language. The agent reads `SKILL.md`, understands available commands, and executes `ros2_cli.py` to interact with ROS 2 directly via rclpy — no rosbridge required, perfect for on-board deployment.

The long-term goal is full parity with the `ros2` CLI — every command available in a terminal, made accessible to an AI agent. Beyond that baseline, ros2-skill adds capabilities that only make sense in an agent context: goal-conditioned publishing, sensor image capture, system diagnostics, and external integrations like Discord reporting.

## Quick Start

**ros2-skill** works with any AI agent that supports [Agent Skills](https://agentskills.io). For easy setup, I recommend using [nanobot](https://github.com/HKUDS/nanobot), a lightweight alternative to [OpenClaw](https://github.com/openclaw/openclaw) that can run directly on-board the ROS 2 robot's computer. Install **ros2-skill** from [ClawHub](https://clawhub.ai/adityakamath/ros2-skill) and talk to your robot:

- "What topics are available?"
- "Move the robot forward 1 meter"
- "Trigger the emergency stop"

**Agent Workflow:** The agent automatically:
1. Understands user intent (subscribe/publish/call/send/run/launch)
2. Discovers relevant launch files, nodes, topics, services, actions from the live graph
3. Finds message types and structures
4. Applies safety limits from parameters
5. Executes the command

No user clarification needed — the agent uses ros2-skill tools to answer all its own questions, including finding and launching the robot stack if it isn't already running.

For nanobot deployments, load both `SKILL.md` (command reference) and `AGENTS.md` (operational rules and safety constraints) into the agent's system prompt. The full rule set is in [`references/RULES.md`](references/RULES.md).

> **Note:** `ros2_cli.py` is intended for debugging and development only. Normal usage is through the chat interface or messaging gateway of your agent platform. See [`references/CLI.md`](references/CLI.md) for the full command list.

## How It Works

1. The agent platform loads `SKILL.md` into the agent's system prompt
2. The agent platform substitutes `{baseDir}` with the actual skill installation path
3. User asks something like "move the robot forward"
4. **Agent thinks:** "This requires publishing velocity commands. I need to find Twist topics, get the message structure, check safety limits, then publish."
5. **Agent auto-discovers:**
   - `topics find geometry_msgs/Twist` + `TwistStamped` → finds the velocity topic
   - `topics message geometry_msgs/Twist` → gets structure
   - `nodes list` + `params list <controller_node>` → gets safety limits
6. Agent executes: `python3 {baseDir}/scripts/ros2_cli.py topics publish /cmd_vel ...`
7. `ros2_cli.py` uses rclpy to communicate with ROS 2 and returns JSON
8. Agent parses the JSON and responds in natural language

The agent never asks for clarification — it automatically discovers topics, services, actions, message types, topic names, and safety limits from the live ROS 2 graph.

## File Structure

```
ros2-skill/
├── SKILL.md                   # Skill document (loaded into agent's system prompt)
├── scripts/
│   ├── ros2_cli.py            # Entry point — parser, dispatch table, re-exports
│   ├── ros2_utils.py          # Shared infrastructure (ROS2CLI node, output, msg helpers)
│   ├── ros2_topic.py          # Topic commands + estop + battery + diag
│   ├── ros2_node.py           # Node commands
│   ├── ros2_param.py          # Parameter commands + presets
│   ├── ros2_service.py        # Service commands
│   ├── ros2_action.py         # Action commands
│   ├── ros2_lifecycle.py      # Lifecycle (managed node) commands
│   ├── ros2_interface.py      # Interface type discovery commands
│   ├── ros2_doctor.py         # Doctor / Wtf system diagnostics
│   ├── ros2_multicast.py      # Multicast (UDP) diagnostics
│   ├── ros2_control.py        # Controller manager commands
│   ├── ros2_tf.py             # TF2 transform commands and math helpers
│   ├── ros2_launch.py         # Launch file session management (tmux)
│   ├── ros2_run.py            # Executable session management (tmux)
│   ├── ros2_bag.py            # Bag file utilities (info)
│   ├── ros2_component.py      # Composable node utilities (types, list, load, unload, kill, standalone)
│   ├── ros2_pkg.py            # Package utilities (list, prefix, executables, xml)
│   ├── ros2_daemon.py         # ROS 2 daemon management
│   └── discord_tools.py       # Discord integration
├── references/
│   ├── CLI.md                 # Supported commands, agent features, global options
│   ├── COMMANDS.md            # Full command reference with output examples
│   ├── EXAMPLES.md            # Practical usage guide for agents
│   └── RULES.md               # Agent safety rules and operational constraints
├── tests/
│   └── test_ros2_cli.py       # Unit tests
├── AGENTS.md                  # Agent system prompt — load alongside SKILL.md for nanobot deployments
└── CHANGELOG.md               # Version history
```

## Requirements

- Python 3.10+
- ROS 2, environment sourced
- `tmux` — required for `launch` and `run` commands (session management)

**Optional:**
- `opencv-python` and `numpy` — required for `topics capture-image`
- `requests` — required for `discord_tools.py send-image`

## Output Directories

Commands that produce file artifacts write to subdirectories of the skill installation root:

| Directory | Contents |
|-----------|----------|
| `.artifacts/` | Captured images, logs, and all other generated outputs |
| `.presets/` | Saved parameter presets (`params preset-save` / `params preset-load`) |
| `.profiles/` | Robot profiles |

## Discord Setup

`discord_tools.py send-image` reads its bot token from a config file — the same one used by nanobot:

```json
// ~/.nanobot/config.json
{
  "channels": {
    "discord": {
      "token": "YOUR_BOT_TOKEN"
    }
  }
}
```

See [`AGENTS.md`](AGENTS.md) for the full Discord image-sending workflow.

## Testing

```bash
source /opt/ros/${ROS_DISTRO}/setup.bash
python3 -m pytest tests/ -v
```

Tests that require a live ROS 2 environment will skip gracefully if one is not available.

Tested with ROS 2 Kilted and [nanobot](https://github.com/HKUDS/nanobot) on a Raspberry Pi.

## Changelog

Current version: **v1.0.5**. See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

Adapted from [ros-skill](https://github.com/lpigeon/ros-skill) by [@lpigeon](https://github.com/lpigeon).

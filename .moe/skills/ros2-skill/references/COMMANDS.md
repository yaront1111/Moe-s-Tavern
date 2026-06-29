# Command Reference

Full reference for all `ros2_cli.py` commands with arguments, options, ROS 2 CLI equivalents, and output examples.

All commands output JSON. Errors return `{"error": "..."}`.

---

## --help Quick Reference

**Every subcommand supports `--help`.** Run it before constructing any command you are unsure about — it prints accepted flags without requiring a live ROS 2 graph.

```bash
# Top-level
python3 {baseDir}/scripts/ros2_cli.py --help

# topics subcommands
python3 {baseDir}/scripts/ros2_cli.py topics publish-until --help
python3 {baseDir}/scripts/ros2_cli.py topics publish-sequence --help
python3 {baseDir}/scripts/ros2_cli.py topics publish --help
python3 {baseDir}/scripts/ros2_cli.py topics subscribe --help
python3 {baseDir}/scripts/ros2_cli.py topics list --help
python3 {baseDir}/scripts/ros2_cli.py topics type --help
python3 {baseDir}/scripts/ros2_cli.py topics details --help
python3 {baseDir}/scripts/ros2_cli.py topics message --help
python3 {baseDir}/scripts/ros2_cli.py topics hz --help
python3 {baseDir}/scripts/ros2_cli.py topics bw --help
python3 {baseDir}/scripts/ros2_cli.py topics delay --help
python3 {baseDir}/scripts/ros2_cli.py topics find --help
python3 {baseDir}/scripts/ros2_cli.py topics capture-image --help
python3 {baseDir}/scripts/ros2_cli.py topics diag --help
python3 {baseDir}/scripts/ros2_cli.py topics battery --help

# services subcommands
python3 {baseDir}/scripts/ros2_cli.py services list --help
python3 {baseDir}/scripts/ros2_cli.py services call --help
python3 {baseDir}/scripts/ros2_cli.py services details --help
python3 {baseDir}/scripts/ros2_cli.py services find --help
python3 {baseDir}/scripts/ros2_cli.py services echo --help

# actions subcommands
python3 {baseDir}/scripts/ros2_cli.py actions list --help
python3 {baseDir}/scripts/ros2_cli.py actions send --help
python3 {baseDir}/scripts/ros2_cli.py actions details --help
python3 {baseDir}/scripts/ros2_cli.py actions cancel --help
python3 {baseDir}/scripts/ros2_cli.py actions echo --help
python3 {baseDir}/scripts/ros2_cli.py actions find --help

# nodes
python3 {baseDir}/scripts/ros2_cli.py nodes list --help
python3 {baseDir}/scripts/ros2_cli.py nodes details --help

# params
python3 {baseDir}/scripts/ros2_cli.py params list --help
python3 {baseDir}/scripts/ros2_cli.py params get --help
python3 {baseDir}/scripts/ros2_cli.py params set --help
python3 {baseDir}/scripts/ros2_cli.py params describe --help
python3 {baseDir}/scripts/ros2_cli.py params dump --help
python3 {baseDir}/scripts/ros2_cli.py params load --help
python3 {baseDir}/scripts/ros2_cli.py params delete --help
python3 {baseDir}/scripts/ros2_cli.py params preset-save --help
python3 {baseDir}/scripts/ros2_cli.py params preset-load --help
python3 {baseDir}/scripts/ros2_cli.py params preset-list --help
python3 {baseDir}/scripts/ros2_cli.py params preset-delete --help

# lifecycle
python3 {baseDir}/scripts/ros2_cli.py lifecycle nodes --help
python3 {baseDir}/scripts/ros2_cli.py lifecycle list --help
python3 {baseDir}/scripts/ros2_cli.py lifecycle get --help
python3 {baseDir}/scripts/ros2_cli.py lifecycle set --help

# control (controller manager)
python3 {baseDir}/scripts/ros2_cli.py control list-controllers --help
python3 {baseDir}/scripts/ros2_cli.py control list-controller-types --help
python3 {baseDir}/scripts/ros2_cli.py control list-hardware-components --help
python3 {baseDir}/scripts/ros2_cli.py control list-hardware-interfaces --help
python3 {baseDir}/scripts/ros2_cli.py control load-controller --help
python3 {baseDir}/scripts/ros2_cli.py control unload-controller --help
python3 {baseDir}/scripts/ros2_cli.py control configure-controller --help
python3 {baseDir}/scripts/ros2_cli.py control set-controller-state --help
python3 {baseDir}/scripts/ros2_cli.py control switch-controllers --help
python3 {baseDir}/scripts/ros2_cli.py control set-hardware-component-state --help
python3 {baseDir}/scripts/ros2_cli.py control view-controller-chains --help

# tf
python3 {baseDir}/scripts/ros2_cli.py tf list --help
python3 {baseDir}/scripts/ros2_cli.py tf lookup --help
python3 {baseDir}/scripts/ros2_cli.py tf echo --help
python3 {baseDir}/scripts/ros2_cli.py tf monitor --help
python3 {baseDir}/scripts/ros2_cli.py tf static --help
python3 {baseDir}/scripts/ros2_cli.py tf euler-from-quaternion --help
python3 {baseDir}/scripts/ros2_cli.py tf quaternion-from-euler --help
python3 {baseDir}/scripts/ros2_cli.py tf transform-point --help
python3 {baseDir}/scripts/ros2_cli.py tf transform-vector --help

# other
python3 {baseDir}/scripts/ros2_cli.py estop --help
python3 {baseDir}/scripts/ros2_cli.py doctor --help
python3 {baseDir}/scripts/ros2_cli.py multicast send --help
python3 {baseDir}/scripts/ros2_cli.py multicast receive --help
python3 {baseDir}/scripts/ros2_cli.py launch new --help
python3 {baseDir}/scripts/ros2_cli.py run new --help
python3 {baseDir}/scripts/ros2_cli.py interface show --help
python3 {baseDir}/scripts/ros2_cli.py version --help

# bag (no live ROS 2 graph required)
python3 {baseDir}/scripts/ros2_cli.py bag info --help

# component
python3 {baseDir}/scripts/ros2_cli.py component types --help        # no live graph required
python3 {baseDir}/scripts/ros2_cli.py component list --help
python3 {baseDir}/scripts/ros2_cli.py component ls --help
python3 {baseDir}/scripts/ros2_cli.py component load --help
python3 {baseDir}/scripts/ros2_cli.py component unload --help
python3 {baseDir}/scripts/ros2_cli.py component kill --help
python3 {baseDir}/scripts/ros2_cli.py component standalone --help

# pkg (no live ROS 2 graph required)
python3 {baseDir}/scripts/ros2_cli.py pkg list --help
python3 {baseDir}/scripts/ros2_cli.py pkg prefix --help
python3 {baseDir}/scripts/ros2_cli.py pkg executables --help
python3 {baseDir}/scripts/ros2_cli.py pkg xml --help

# daemon (no live ROS 2 graph required)
python3 {baseDir}/scripts/ros2_cli.py daemon status --help
python3 {baseDir}/scripts/ros2_cli.py daemon start --help
python3 {baseDir}/scripts/ros2_cli.py daemon stop --help
```

**Rule:** If you are about to use a flag and you have any doubt it exists, run `--help` for that subcommand first. Never guess flag names.

---

## Global Options

These options are placed **before** the command name and apply to every command that makes service or action calls.

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | (per-command default) | Override the per-command timeout with a global value (e.g. `--timeout 30` for a slow network) |
| `--retries N` | `1` | Total number of attempts for each service/action call before giving up. `1` means no retry |

```bash
# Override timeout globally for a slow ROS graph
python3 {baseDir}/scripts/ros2_cli.py --timeout 30 params list /turtlesim

# Retry up to 3 times on an unreliable network
python3 {baseDir}/scripts/ros2_cli.py --retries 3 lifecycle get /camera_driver

# Combine both: 10 s per attempt, 3 attempts
python3 {baseDir}/scripts/ros2_cli.py --timeout 10 --retries 3 services call /spawn '{}'
```

**Notes:**
- When `--timeout` is supplied globally, it overrides any per-command `--timeout` default. The per-command `--timeout` (placed after the command name) is used only when no global `--timeout` is set.
- `--retries 1` (the default) means a single attempt with no retry — existing behaviour is preserved.

---

## Agent Features

Commands that go beyond standard `ros2` CLI parity — designed specifically for AI agents operating on mobile robots.

---

## estop

Emergency stop for mobile robots. Auto-detects the velocity command topic and message type, then publishes zero velocity.

**Note:** For mobile robots only (differential drive, omnidirectional, etc.). Does NOT work for robotic arms or manipulators.

**ROS 2 CLI equivalent:** `ros2 topic pub --once /cmd_vel geometry_msgs/msg/Twist '{}'`

| Option | Default | Description |
|--------|---------|-------------|
| `--topic TOPIC` | auto-detect | Override velocity topic (auto-detected by scanning for `Twist`/`TwistStamped` topics; prefers `cmd_vel`-named topics when multiple exist) |

```bash
python3 {baseDir}/scripts/ros2_cli.py estop
python3 {baseDir}/scripts/ros2_cli.py estop --topic /cmd_vel_nav
```

Output:
```json
{"success": true, "topic": "/cmd_vel", "type": "geometry_msgs/Twist", "message": "Emergency stop activated (mobile robot stopped)"}
```

Error (no velocity topic found):
```json
{"error": "Could not find velocity command topic", "hint": "This command is for mobile robots only (not arms). Ensure the robot has a /cmd_vel topic."}
```

---

## topics capture-image

Capture an image from a ROS 2 image topic and save to the .artifacts/ folder.

| Option | Required | Description |
|--------|----------|-------------|
| --topic | Yes | ROS 2 image topic (e.g. /camera/image_raw/compressed) |
| --output | Yes | Output filename (saved in .artifacts/) |
| --timeout | No | Seconds to wait for image (default: 5.0) |
| --type | No | Image type: compressed, raw, or auto (default: auto) |

Example:
```bash
python3 scripts/ros2_cli.py topics capture-image --topic /camera/image_raw/compressed --output test.jpg --timeout 5 --type auto
```

Output (success):
```json
{"success": true, "path": "/path/to/.artifacts/test.jpg"}
```
Output (error):
```json
{"error": "No image received from /camera/image_raw/compressed within 5 seconds"}
```

---

## discord_tools.py send-image

Send an image file to a Discord channel. The bot token is read from the config file specified by `--config` at `config["channels"]["discord"]["token"]`. Both the config path and channel ID must be provided as CLI arguments by the agent.

| Option | Required | Description |
|--------|----------|-------------|
| --path | Yes | Path to image file (relative or absolute) |
| --channel-id | Yes | Discord channel ID (provided by agent based on context) |
| --config | Yes | Path to nanobot config file (e.g., ~/.nanobot/config.json) |
| --delete | No | Delete image after sending |

**Config file structure:**
```json
{
  "channels": {
    "discord": {
      "token": "YOUR_DISCORD_BOT_TOKEN"
    }
  }
}
```

Example:
```bash
python3 scripts/discord_tools.py send-image --path .artifacts/test.jpg --channel-id 123456789012345678 --config ~/.nanobot/config.json --delete
```

Output (success):
```
Image sent to Discord channel 123456789012345678 successfully.
Deleted image: .artifacts/test.jpg
```
Output (error):
```
Error: Config file not found at /path/to/config.json
```
or
```
Error: --channel-id argument is required
```

---

## topics publish-sequence `<topic>` `<json_messages>` `<json_durations>` [options]

Publish a sequence of messages in order. Each message is repeated at `--rate` Hz for its corresponding duration before moving to the next. Arrays must be the same length. The final message should usually be all-zeros to stop the robot.

**ROS 2 CLI equivalent:** No direct equivalent (requires scripting multiple `ros2 topic pub` calls)

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic to publish to |
| `json_messages` | Yes | JSON array of message objects, published in order |
| `json_durations` | Yes | JSON array of durations in seconds — one per message |

| Option | Default | Description |
|--------|---------|-------------|
| `--msg-type TYPE` | auto-detect | Override message type |
| `--rate HZ` | `10` | Publish rate in Hz for each step |
| `--max-vel LIN` | _(none)_ | Clamp `linear.x/y/z` to ±LIN m/s before publishing (Twist / TwistStamped only) |
| `--max-ang ANG` | _(none)_ | Clamp `angular.z` to ±ANG rad/s before publishing (Twist / TwistStamped only) |

**⚠️ WARNING — `publish-sequence` is open-loop and time-based. It has no sensor feedback and cannot guarantee distance or angle accuracy.**

- **DO NOT use `publish-sequence` when the user specifies a distance ("move 1 meter") or angle ("rotate 90 degrees") and odometry is available.** Use `topics publish-until` with `--monitor <odom_topic>` instead (see below).
- Use `publish-sequence` only when: (a) no distance/angle is specified and a timed motion pattern is acceptable, OR (b) odometry is genuinely unavailable. In case (b), notify the user that accuracy is not guaranteed.

**[FALLBACK] Drive forward for a fixed time, then stop (no distance guarantee):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-sequence /cmd_vel \
  '[{"linear":{"x":1.0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}},{"linear":{"x":0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}]' \
  '[3.0, 0.5]'
```

**[FALLBACK] Draw a square (turtlesim — simulation only, odometry not relevant):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-sequence /turtle1/cmd_vel \
  '[{"linear":{"x":2},"angular":{"z":0}},{"linear":{"x":0},"angular":{"z":1.5708}},{"linear":{"x":2},"angular":{"z":0}},{"linear":{"x":0},"angular":{"z":1.5708}},{"linear":{"x":2},"angular":{"z":0}},{"linear":{"x":0},"angular":{"z":1.5708}},{"linear":{"x":2},"angular":{"z":0}},{"linear":{"x":0},"angular":{"z":1.5708}},{"linear":{"x":0},"angular":{"z":0}}]' \
  '[1,1,1,1,1,1,1,1,0.5]'
```

Output:
```json
{"success": true, "published_count": 35, "topic": "/cmd_vel", "rate": 10.0}
```

Error (array length mismatch):
```json
{"error": "messages and durations arrays must have the same length"}
```

---

## topics publish-until `<topic>` `<msg>` [options]

Publish a message at a fixed rate while simultaneously monitoring a second topic. Stops as soon as a condition on the monitored field is satisfied, or after the safety timeout. Supports single-field conditions and N-dimensional Euclidean distance.

**ROS 2 CLI equivalent:** No equivalent (requires custom scripting)

**Discovery workflow:**

**Path A (profile loaded):** read `summary.localization_config.fused_sources` for the odometry topic — do NOT run `topics find nav_msgs/msg/Odometry`. Run `topics message nav_msgs/msg/Odometry` once per session for the field-path reference. Run `topics subscribe <ODOM_TOPIC> --duration 2` for the current baseline value.

**Path B (no profile):** run the live-discovery sequence below.
1. `topics find nav_msgs/msg/Odometry` — find the feedback topic (for --rotate or --field)
2. `topics message nav_msgs/msg/Odometry` — inspect field paths (for --field)
3. `topics subscribe <ODOM_TOPIC> --duration 2` — read current value (baseline for `--delta`)
4. For rotation: use `--rotate ±N` — positive = CCW (left), negative = CW (right). Sign MUST match `angular.z` sign in the message payload.

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic to publish command messages to |
| `json_message` | Yes | JSON string of the message payload |

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--monitor TOPIC` | Yes | — | Topic to watch for the stop condition |
| `--field PATH [PATH...]` | Yes (unless --rotate) | — | One or more dot-separated field paths in the monitor message (e.g. `pose.pose.position.x`). Provide multiple paths with `--euclidean`. |
| `--rotate ±N` | Alternative to --field | — | Rotate by N radians. **Sign determines direction: positive = CCW (left turn), negative = CW (right turn). Sign of `--rotate` MUST match sign of `angular.z` in the payload — mismatched signs cause the command to run until timeout.** Zero is invalid. Handles quaternion math internally. |
| `--degrees` | No | radians | Interpret --rotate angle in degrees instead of radians |
| `--euclidean` | No | off | Compute Euclidean distance across all `--field` paths; requires `--delta`. Works for any number of numeric fields (2D, 3D, joint-space, etc.) |
| `--delta N` | One required | — | Stop when field changes by ±N from first observed value; or when Euclidean distance ≥ N with `--euclidean` |
| `--above N` | One required | — | Stop when field value > N (single-field only) |
| `--below N` | One required | — | Stop when field value < N (single-field only) |
| `--equals V` | One required | — | Stop when field value == V (single-field only) |
| `--rate HZ` | No | `10` | Publish rate in Hz |
| `--timeout SECONDS` | No | `60` | Safety stop if condition not met within this time |
| `--msg-type TYPE` | No | auto-detect | Override publish topic message type |
| `--monitor-msg-type TYPE` | No | auto-detect | Override monitor topic message type |
| `--slow-last N` | No | **auto** | Override the auto-computed deceleration zone (see below). Units: metres for `--field`/`--euclidean`; degrees if `--degrees` set, radians otherwise for `--rotate`. |
| `--slow-factor F` | No | **auto** | Override the auto-computed fine-control floor (0–1 fraction of commanded speed). |
| `--max-vel LIN` | No | _(none)_ | Clamp `linear.x/y/z` to ±LIN m/s before the first publish (Twist / TwistStamped only) |
| `--max-ang ANG` | No | _(none)_ | Clamp `angular.z` to ±ANG rad/s before the first publish (Twist / TwistStamped only) |

**Note:** Either `--field` OR `--rotate` must be specified, but not both. `--slow-last` works with `--delta`, `--euclidean --delta`, and `--rotate`; ignored for `--above`/`--below`/`--equals`.

#### Auto-computed deceleration zone

When `--slow-last` is **not** provided, the skill computes the decel zone automatically at startup from the commanded velocity and live node params (2 s timeout):

| Move type | Formula | Fallback `a_max` | Fallback fine-control floor |
|-----------|---------|-----------------|----------------------------|
| linear.x | `v_cmd² / (2 × a_max)`, clamped [0.05 m, distance × 0.4] | 0.5 m/s² | 0.125 m/s |
| linear.y | same | 0.5 m/s² | 0.100 m/s |
| angular.z | `ω_cmd² / (2 × α_max)`, clamped [3°, angle × 0.4] | 1.0 rad/s² | 0.375 rad/s |

Params searched: `max_accel`, `accel_limit`, `decel_limit` (accel); `min_vel_x/y`, `min_vel`, `min_speed` (min vel); `max_ang_accel`, `ang_accel_limit` (angular accel); `min_ang_vel`, `min_angular_speed` (min angular vel). First numeric match wins. Falls back to defaults if nothing found.

The computed zone is reported in every `publish-until` result:
```json
"decel_zone": {
  "auto_computed": true,
  "slow_last": 0.32,
  "slow_factor": 0.28,
  "params_source": "/velocity_controller:max_accel"
}
```

If `--slow-last` **is** provided, auto-compute is skipped and `"decel_zone": {"auto_computed": false}` is returned.

**Move forward until x-position increases by 1 m (straight path):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0.3,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' \
  --monitor /odom --field pose.pose.position.x --delta 1.0 --timeout 30
```

**Move 2 m in XY plane (Euclidean — works for curved/diagonal paths):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0.2,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0.3}}' \
  --monitor /odom \
  --field pose.pose.position.x pose.pose.position.y \
  --euclidean --delta 2.0 --timeout 60
```

**Move until joint_3 reaches 1.5 rad:**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /arm/cmd \
  '{"joint_3_velocity":0.2}' \
  --monitor /joint_states --field position.2 --equals 1.5 --timeout 20
```

**Stop when front lidar range drops below 0.5 m:**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0.2,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' \
  --monitor /scan --field ranges.0 --below 0.5 --timeout 60
```

**Direction convention — `--rotate` sign and `angular.z` sign must always match:**

| Direction | `--rotate` | `angular.z` |
|-----------|-----------|-------------|
| Left / CCW | positive | positive |
| Right / CW | negative | negative |

Mismatched signs (e.g. `--rotate 90` with `angular.z: -0.5`) means the robot turns CW while the monitor waits for CCW accumulation — the command will never stop until timeout.

**Rotate 90 degrees CCW (positive --rotate, positive angular.z):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0},"angular":{"z":0.5}}' \
  --monitor /odom --rotate 90 --degrees --timeout 30
```

**Rotate 90 degrees CW (negative --rotate, negative angular.z):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0},"angular":{"z":-0.5}}' \
  --monitor /odom --rotate -90 --degrees --timeout 30
```

**Rotate 180 degrees CCW (using radians):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0},"angular":{"z":0.5}}' \
  --monitor /odom --rotate 3.14159 --timeout 30
```

**Drive 10 m forward with deceleration for the last 0.3 m (precision landing):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0.2},"angular":{"z":0}}' \
  --monitor /odom --field pose.pose.position --euclidean --delta 10.0 \
  --slow-last 0.3 --slow-factor 0.25 --timeout 120
```

**Drive 15 cm forward — short distance, decel zone spans the whole move:**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0.1},"angular":{"z":0}}' \
  --monitor /odom --field pose.pose.position --euclidean --delta 0.15 \
  --slow-last 0.3 --slow-factor 0.25 --timeout 15
```
*(When `--slow-last` > total distance, deceleration applies from the start — velocity ramps from 0.1 × (0.15/0.3) = 0.05 m/s down to 0.1 × 0.25 = 0.025 m/s.)*

**Rotate 10° CCW with decel for the last 20° (or the whole move, whichever is shorter):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /cmd_vel \
  '{"linear":{"x":0},"angular":{"z":0.3}}' \
  --monitor /odom --rotate 10 --degrees \
  --slow-last 20 --slow-factor 0.25 --timeout 15
```

**Stop when temperature exceeds 50°C:**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish-until /heater/cmd \
  '{"power":1.0}' \
  --monitor /temperature --field temperature --above 50.0 --timeout 120
```

Output — single-field condition met:
```json
{
  "success": true, "condition_met": true,
  "topic": "/cmd_vel", "monitor_topic": "/odom",
  "field": "pose.pose.position.x", "operator": "delta", "threshold": 1.0,
  "start_value": 0.12, "end_value": 1.15,
  "duration": 4.2, "published_count": 42,
  "start_msg": {}, "end_msg": {}
}
```

Output — Euclidean condition met:
```json
{
  "success": true, "condition_met": true,
  "topic": "/cmd_vel", "monitor_topic": "/odom",
  "fields": ["pose.pose.position.x", "pose.pose.position.y"],
  "operator": "euclidean_delta", "threshold": 2.0,
  "start_values": [0.0, 0.0], "end_values": [1.42, 1.41],
  "euclidean_distance": 2.003,
  "duration": 9.8, "published_count": 98,
  "start_msg": {}, "end_msg": {}
}
```

Output — timeout (condition not met):
```json
{
  "success": false, "condition_met": false,
  "error": "Timeout after 30s: condition not met",
  "start_value": 0.12, "end_value": 0.43,
  "duration": 30.0, "published_count": 298
}
```

---

## topics diag-list

List all topics that publish `DiagnosticArray` messages, discovered by **type** rather than by name. Handles `/diagnostics`, `<node>/diagnostics`, `<namespace>/diagnostics`, or any other naming convention.

```bash
python3 {baseDir}/scripts/ros2_cli.py topics diag-list
```

Output:
```json
{"topics": [{"topic": "/diagnostics", "type": "diagnostic_msgs/msg/DiagnosticArray"}, {"topic": "/camera/diagnostics", "type": "diagnostic_msgs/msg/DiagnosticArray"}], "count": 2}
```

---

## topics diag [options]

Subscribe to diagnostic topics and return parsed `DiagnosticStatus` entries with human-readable level names. Auto-discovers all diagnostic topics by type unless `--topic` is specified.

| Option | Default | Description |
|--------|---------|-------------|
| `--topic TOPIC` | auto-discover all | Specific diagnostic topic to read from |
| `--duration SEC` | one-shot | Collect messages for N seconds |
| `--max-messages N` | `1` | Max messages per topic in `--duration` mode |
| `--timeout SEC` | `10` | Timeout waiting for first message (one-shot mode) |

```bash
# One-shot: read latest diagnostics from all discovered topics
python3 {baseDir}/scripts/ros2_cli.py topics diag

# Read from a specific (non-standard) diagnostic topic
python3 {baseDir}/scripts/ros2_cli.py topics diag --topic /my_node/diagnostics

# Collect 5 messages per topic over 10 seconds
python3 {baseDir}/scripts/ros2_cli.py topics diag --duration 10 --max-messages 5
```

Output:
```json
{
  "results": [
    {
      "topic": "/diagnostics",
      "stamp": {"sec": 1234567890, "nanosec": 0},
      "status": [
        {
          "level": 0, "level_name": "OK",
          "name": "motor_driver: left", "message": "OK",
          "hardware_id": "motor_driver",
          "values": [{"key": "temperature", "value": "38.5"}]
        },
        {
          "level": 1, "level_name": "WARN",
          "name": "battery", "message": "Low charge",
          "hardware_id": "power_board",
          "values": [{"key": "voltage", "value": "11.2"}]
        }
      ]
    }
  ],
  "topic_count": 1
}
```

Level values: `0` = OK, `1` = WARN, `2` = ERROR, `3` = STALE.

---

## topics battery-list

List all topics that publish `BatteryState` messages, discovered by **type** rather than by name. Handles `/battery_state`, `<robot>/battery_state`, or any other naming convention.

```bash
python3 {baseDir}/scripts/ros2_cli.py topics battery-list
```

Output:
```json
{"topics": [{"topic": "/battery_state", "type": "sensor_msgs/msg/BatteryState"}], "count": 1}
```

---

## topics battery [options]

Subscribe to battery topics and return a decoded `BatteryState` summary. Auto-discovers all battery topics by type unless `--topic` is specified.

| Option | Default | Description |
|--------|---------|-------------|
| `--topic TOPIC` | auto-discover all | Specific battery topic to read from |
| `--duration SEC` | one-shot | Collect messages for N seconds |
| `--max-messages N` | `1` | Max messages per topic in `--duration` mode |
| `--timeout SEC` | `10` | Timeout waiting for first message (one-shot mode) |

```bash
# One-shot: read latest battery state from all discovered topics
python3 {baseDir}/scripts/ros2_cli.py topics battery

# Read from a specific battery topic
python3 {baseDir}/scripts/ros2_cli.py topics battery --topic /my_robot/battery_state

# Collect 3 messages per topic over 5 seconds
python3 {baseDir}/scripts/ros2_cli.py topics battery --duration 5 --max-messages 3
```

Output:
```json
{
  "results": [
    {
      "topic": "/battery_state",
      "battery": {
        "percentage": 75.0,
        "voltage": 12.4,
        "current": -2.1,
        "charge": 3.5,
        "capacity": 5.0,
        "design_capacity": 5.2,
        "temperature": 25.0,
        "present": true,
        "power_supply_status": 2,
        "status_name": "DISCHARGING",
        "power_supply_health": 1,
        "health_name": "GOOD",
        "power_supply_technology": 3,
        "technology_name": "LIPO",
        "location": "slot_0",
        "serial_number": "SN-001"
      }
    }
  ],
  "topic_count": 1
}
```

`status_name` values: UNKNOWN, CHARGING, DISCHARGING, NOT_CHARGING, FULL.
`health_name` values: UNKNOWN, GOOD, OVERHEAT, DEAD, OVERVOLTAGE, UNSPEC_FAILURE, COLD, WATCHDOG_TIMER_EXPIRE, SAFETY_TIMER_EXPIRE.
`technology_name` values: UNKNOWN, NIMH, LION, LIPO, LIFE, NICD, LIMN.

---

## params preset-save `<node>` `<preset>` [options]

Save the current parameters of a node as a named preset. Internally calls `ListParameters` + `GetParameters` and writes a `{param_name: value}` JSON file to `.presets/{preset}.json` (beside the skill directory, created automatically — flat storage, no subdirectories). Requires the node to be running.

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name (e.g. `/turtlesim`) |
| `preset` | Yes | Preset name (e.g. `turtlesim_indoor`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py params preset-save /turtlesim turtlesim_indoor
python3 {baseDir}/scripts/ros2_cli.py params preset-save /turtlesim turtlesim_outdoor --timeout 10
```

Output:
```json
{"node": "/turtlesim", "preset": "turtlesim_indoor", "path": "/path/to/ros2-skill/.presets/turtlesim_indoor.json", "count": 3}
```

---

## params preset-load `<node>` `<preset>` [options]

Restore a named preset onto a node by reading the saved JSON file and calling `SetParameters`. Per-parameter success and failure reasons are reported individually.

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name (e.g. `/turtlesim`) |
| `preset` | Yes | Preset name to restore (e.g. `turtlesim_indoor`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py params preset-load /turtlesim turtlesim_indoor
```

Output (success):
```json
{"node": "/turtlesim", "results": [{"name": "background_r", "success": true}, {"name": "background_g", "success": true}, {"name": "background_b", "success": true}]}
```

Output (preset not found):
```json
{"error": "Preset 'turtlesim_indoor' not found", "path": "/path/to/ros2-skill/.presets/turtlesim_indoor.json"}
```

---

## params preset-list

List all saved presets. Reads from `.presets/` (beside the skill directory) — no running ROS 2 graph required. Presets are stored flat; use descriptive names (e.g. `turtlesim_indoor`) to identify the node.

```bash
python3 {baseDir}/scripts/ros2_cli.py params preset-list
```

Output:
```json
{"presets": [{"preset": "turtlesim_indoor", "path": "/path/to/ros2-skill/.presets/turtlesim_indoor.json"}, {"preset": "turtlesim_outdoor", "path": "/path/to/ros2-skill/.presets/turtlesim_outdoor.json"}], "count": 2}
```

---

## params preset-delete `<preset>`

Delete a saved preset file from `.presets/`. No running ROS 2 graph required.

| Argument | Required | Description |
|----------|----------|-------------|
| `preset` | Yes | Preset name to delete (e.g. `turtlesim_indoor`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py params preset-delete turtlesim_indoor
```

Output:
```json
{"preset": "turtlesim_indoor", "deleted": true}
```

---

## ROS 2 CLI Commands

Commands that provide parity with the standard `ros2` CLI.

---

## context

Compact session-start graph snapshot: topics, services, actions, and nodes in a single call.

**Use at session start** (Rule 0.1 Step 5) to pre-load graph state rather than running four separate discovery commands.

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | `50` | Max topics to return. Use `--limit 0` for the full list. |

```bash
python3 {baseDir}/scripts/ros2_cli.py context
python3 {baseDir}/scripts/ros2_cli.py context --limit 0      # full topic list
python3 {baseDir}/scripts/ros2_cli.py context --limit 100
```

Output (normal):
```json
{
  "topics": ["/cmd_vel", "/odom", "/scan"],
  "topic_types": ["geometry_msgs/msg/Twist", "nav_msgs/msg/Odometry", "sensor_msgs/msg/LaserScan"],
  "services": ["/robot_state_publisher/get_parameters"],
  "actions": ["/navigate_to_pose"],
  "nodes": ["/robot_state_publisher", "/controller_manager"],
  "counts": {"topics": 3, "services": 1, "actions": 1, "nodes": 2}
}
```

Output (truncated — more than 50 topics):
```json
{
  "topics": ["...", "..."],
  "topic_types": ["...", "..."],
  "services": ["..."],
  "actions": [],
  "nodes": ["..."],
  "counts": {"topics": 87, "services": 42, "actions": 0, "nodes": 12},
  "topics_truncated": true,
  "topics_shown": 50
}
```

---

## version

Detect the ROS 2 version and distro name.

**ROS 2 CLI equivalent:** `ros2 doctor --report` (verbose), or `echo $ROS_DISTRO`

```bash
python3 {baseDir}/scripts/ros2_cli.py version
```

Output:
```json
{"version": "2", "distro": "humble", "domain_id": 0}
```

---

## topics list / topics ls

List all active topics with their message types.

**Aliases:** `topics ls`

**ROS 2 CLI equivalent:** `ros2 topic list -t`

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | `0` (unlimited) | Cap number of topics returned. Adds `truncated: true` and `total` when applied. |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics list
python3 {baseDir}/scripts/ros2_cli.py topics ls
python3 {baseDir}/scripts/ros2_cli.py topics list --limit 50
```

Output (normal):
```json
{
  "topics": ["/turtle1/cmd_vel", "/turtle1/pose", "/rosout"],
  "types": ["geometry_msgs/Twist", "turtlesim/Pose", "rcl_interfaces/msg/Log"],
  "count": 3
}
```

Output (truncated):
```json
{
  "topics": ["/cmd_vel", "/odom"],
  "types": ["geometry_msgs/msg/Twist", "nav_msgs/msg/Odometry"],
  "count": 2,
  "total": 87,
  "truncated": true
}
```

---

## topics type `<topic>`

Get the message type of a specific topic.

**ROS 2 CLI equivalent:** `ros2 topic type /topic`

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic name (e.g. `/cmd_vel`, `/turtle1/pose`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics type /turtle1/cmd_vel
python3 {baseDir}/scripts/ros2_cli.py topics type /scan
```

Output:
```json
{"topic": "/turtle1/cmd_vel", "type": "geometry_msgs/Twist"}
```

---

## topics details `<topic>` / topics info `<topic>`

Get topic details including message type, publishers, and subscribers.

**Aliases:** `topics info`

**ROS 2 CLI equivalent:** `ros2 topic info /topic`

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic name |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics details /turtle1/cmd_vel
python3 {baseDir}/scripts/ros2_cli.py topics info /turtle1/cmd_vel
```

Output:
```json
{
  "topic": "/turtle1/cmd_vel",
  "type": "geometry_msgs/Twist",
  "publishers": [],
  "subscribers": ["/turtlesim"]
}
```

---

## topics message `<message_type>` / topics message-structure / topics message-struct

Get the full field structure of a message type as a JSON template.

**Aliases:** `topics message-structure`, `topics message-struct`

**ROS 2 CLI equivalent:** `ros2 interface show geometry_msgs/msg/Twist`

| Argument | Required | Description |
|----------|----------|-------------|
| `message_type` | Yes | Message type — full form (`geometry_msgs/msg/Twist`) or short form (`geometry_msgs/Twist`) both accepted |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics message geometry_msgs/msg/Twist
python3 {baseDir}/scripts/ros2_cli.py topics message-structure geometry_msgs/msg/Twist
python3 {baseDir}/scripts/ros2_cli.py topics message-struct sensor_msgs/msg/LaserScan
```

Output:
```json
{
  "message_type": "geometry_msgs/Twist",
  "structure": {
    "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
    "angular": {"x": 0.0, "y": 0.0, "z": 0.0}
  }
}
```

---

## topics subscribe `<topic>` [options] / topics echo

Subscribe to a topic and receive messages. Without `--duration`, returns the first message received. With `--duration`, collects multiple messages for the specified number of seconds.

**Aliases:** `topics echo`

**ROS 2 CLI equivalent:** `ros2 topic echo /topic`

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic to subscribe to |

| Option | Default | Description |
|--------|---------|-------------|
| `--msg-type TYPE` | auto-detect | Override message type (usually not needed) |
| `--duration SECONDS` | _(none)_ | Collect messages for this duration; without this flag, returns first message only |
| `--max-messages N` / `--max-msgs N` | `100` | Maximum messages to collect (only applies with `--duration`) |
| `--timeout SECONDS` | `5` | Timeout waiting for first message (single-message mode only) |

**Wait for first message (single-message mode):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics subscribe /turtle1/pose
python3 {baseDir}/scripts/ros2_cli.py topics echo /odom
```

Output (single message):
```json
{
  "msg": {"x": 5.544, "y": 5.544, "theta": 0.0, "linear_velocity": 0.0, "angular_velocity": 0.0}
}
```

**Collect messages over time:**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics subscribe /odom --duration 5
python3 {baseDir}/scripts/ros2_cli.py topics echo /scan --duration 10 --max-messages 50
python3 {baseDir}/scripts/ros2_cli.py topics subscribe /joint_states --duration 3 --max-msgs 20
```

Output (multiple messages):
```json
{
  "topic": "/odom",
  "collected_count": 50,
  "messages": [
    {"header": {}, "pose": {"pose": {"position": {"x": 0.1, "y": 0.0, "z": 0.0}}}},
    "..."
  ]
}
```

Error (timeout):
```json
{"error": "Timeout waiting for message"}
```

---

## topics publish `<topic>` `<json_message>` [options] / topics pub / topics publish-continuous

Publish a message to a topic. Without `--duration`/`--timeout`, sends once (single-shot). With either flag, publishes repeatedly at `--rate` Hz for the specified duration, then stops.

**Aliases:** `topics pub`, `topics publish-continuous` (all three share the same handler)

**ROS 2 CLI equivalent:** `ros2 topic pub /topic geometry_msgs/msg/Twist '{"linear": {"x": 1.0}}'`

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic to publish to |
| `json_message` | Yes | JSON string of the message payload |

| Option | Default | Description |
|--------|---------|-------------|
| `--msg-type TYPE` | auto-detect | Override message type |
| `--duration SECONDS` | _(none)_ | Publish repeatedly for this many seconds; identical to `--timeout` |
| `--timeout SECONDS` | _(none)_ | Alias for `--duration`; interchangeable |
| `--rate HZ` | `10` | Publish rate in Hz |
| `--max-vel LIN` | _(none)_ | Clamp `linear.x/y/z` to ±LIN m/s before publishing (Twist / TwistStamped only) |
| `--max-ang ANG` | _(none)_ | Clamp `angular.z` to ±ANG rad/s before publishing (Twist / TwistStamped only) |

**Single-shot (one message):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish /trigger '{"data": ""}'
python3 {baseDir}/scripts/ros2_cli.py topics pub /turtle1/cmd_vel \
  '{"linear":{"x":2.0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}'
```

Output (single-shot):
```json
{"success": true, "topic": "/turtle1/cmd_vel", "msg_type": "geometry_msgs/Twist"}
```

**With velocity ceiling (catches over-limit values before they reach the wire):**
```bash
python3 {baseDir}/scripts/ros2_cli.py topics publish /cmd_vel \
  '{"linear":{"x":1.5},"angular":{"z":0}}' --max-vel 0.5 --max-ang 1.0
```

Output (clamped):
```json
{"success": true, "topic": "/cmd_vel", "msg_type": "geometry_msgs/msg/Twist",
 "velocity_clamped": ["linear.x: 1.5 → 0.5 (clamped to ±0.5)"]}
```

**Publish for a duration (recommended for velocity commands):**
```bash
# Move forward for 3 seconds
python3 {baseDir}/scripts/ros2_cli.py topics publish /cmd_vel \
  '{"linear":{"x":1.0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' --duration 3

# Rotate left for 2 seconds (using --timeout alias)
python3 {baseDir}/scripts/ros2_cli.py topics pub /cmd_vel \
  '{"linear":{"x":0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0.5}}' --timeout 2

# Stop the robot
python3 {baseDir}/scripts/ros2_cli.py topics publish /cmd_vel \
  '{"linear":{"x":0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}'

# Using publish-continuous alias
python3 {baseDir}/scripts/ros2_cli.py topics publish-continuous /cmd_vel \
  '{"linear":{"x":0.3,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' --timeout 5
```

Output (duration mode):
```json
{"success": true, "topic": "/cmd_vel", "msg_type": "geometry_msgs/Twist", "duration": 3.002, "rate": 10.0, "published_count": 30, "stopped_by": "timeout"}
```

`stopped_by` is `"timeout"` when the duration expires normally, or `"keyboard_interrupt"` if stopped early with Ctrl+C.

---

## topics hz `<topic>` [options]

Measure the publish rate of a topic. Collects inter-message intervals over a sliding window and reports rate, min/max delta, and standard deviation.

**ROS 2 CLI equivalent:** `ros2 topic hz /topic`

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic name |

| Option | Default | Description |
|--------|---------|-------------|
| `--window N` | `10` | Number of inter-message intervals to sample |
| `--timeout SECONDS` | `10` | Max wait time; returns error if fewer than 2 messages arrive |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics hz /turtle1/pose
python3 {baseDir}/scripts/ros2_cli.py topics hz /scan --window 20 --timeout 15
python3 {baseDir}/scripts/ros2_cli.py topics hz /odom --window 5
```

Output:
```json
{
  "topic": "/turtle1/pose",
  "rate": 62.4831,
  "min_delta": 0.015832,
  "max_delta": 0.016201,
  "std_dev": 0.000089,
  "samples": 10
}
```

Error (insufficient messages):
```json
{"error": "Fewer than 2 messages received within 10.0s on '/turtle1/pose'"}
```

---

## topics qos-check `<topic>` [options]

Inspect the QoS profiles of all publishers and subscribers on `<topic>` and report whether they are compatible. When a publisher uses `BEST_EFFORT` reliability and a subscriber uses `RELIABLE`, messages are silently discarded — this command detects that and suggests the corrective flag.

**Run this before `publish-until` or any subscribe that times out unexpectedly.** It replaces manual interpretation of `topics details` output.

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Full topic name (e.g. `/odom`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Node spin timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics qos-check /odom
python3 {baseDir}/scripts/ros2_cli.py topics qos-check /cmd_vel
```

**Output (incompatible):**
```json
{
  "topic": "/odom",
  "publisher_count": 1,
  "subscriber_count": 1,
  "publishers": [{"node": "/ekf_node", "reliability": "BEST_EFFORT", "durability": "VOLATILE"}],
  "subscribers": [{"node": "/my_controller", "reliability": "RELIABLE", "durability": "VOLATILE"}],
  "compatible": false,
  "issues": ["reliability mismatch: publisher BEST_EFFORT vs subscriber RELIABLE on /my_controller"],
  "suggestion": "Add --qos-reliability best_effort to your subscribe command to match the publisher"
}
```

**Output (compatible):**
```json
{
  "topic": "/cmd_vel",
  "publisher_count": 1,
  "subscriber_count": 1,
  "compatible": true,
  "issues": [],
  "suggestion": "QoS is compatible — no flags needed"
}
```

**Output (no publisher):**
```json
{
  "topic": "/odom",
  "publisher_count": 0,
  "subscriber_count": 0,
  "compatible": false,
  "issues": ["no publisher on topic /odom"],
  "suggestion": "Check nodes list to verify the publishing node is running"
}
```

---

## topics find `<message_type>`

Find all topics publishing a specific message type. Accepts both `/msg/` and short formats (normalised for comparison).

**ROS 2 CLI equivalent:** `ros2 topic find geometry_msgs/msg/Twist`

| Argument | Required | Description |
|----------|----------|-------------|
| `message_type` | Yes | Message type (e.g. `geometry_msgs/msg/Twist` or `geometry_msgs/Twist`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Timeout in seconds for topic discovery |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/msg/Twist
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/Twist
python3 {baseDir}/scripts/ros2_cli.py topics find nav_msgs/msg/Odometry
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/LaserScan
```

Output:
```json
{
  "message_type": "geometry_msgs/msg/Twist",
  "topics": ["/cmd_vel", "/turtle1/cmd_vel"],
  "count": 2
}
```

No matches:
```json
{"message_type": "geometry_msgs/msg/Twist", "topics": [], "count": 0}
```

---

## topics bw `[topics...]` [options]

Measure the bandwidth of one or more topics in bytes per second. Serialises each received message to measure its size. Pass multiple topic names to monitor them concurrently in a single call (Lyrical Luth feature — works on all distros).

**ROS 2 CLI equivalent:** `ros2 topic bw /topic`

| Argument | Required | Description |
|----------|----------|-------------|
| `topics` | No | One or more topic names (zero triggers `--all`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--all` | false | Monitor all currently-published topics |
| `--window N` | `10` | Number of message samples to collect per topic |
| `--timeout SECONDS` | `10` | Max wait time per topic |

```bash
# Single topic (original format)
python3 {baseDir}/scripts/ros2_cli.py topics bw /camera/image_raw
python3 {baseDir}/scripts/ros2_cli.py topics bw /scan --window 20 --timeout 15

# Multiple topics (concurrent)
python3 {baseDir}/scripts/ros2_cli.py topics bw /scan /odom /cmd_vel
python3 {baseDir}/scripts/ros2_cli.py topics bw /camera/image_raw /scan --window 5
```

Single-topic output:
```json
{
  "topic": "/camera/image_raw",
  "bw": 9437184.0,
  "bytes_per_msg": 921604,
  "rate": 10.24,
  "samples": 10
}
```

Multi-topic output:
```json
{
  "topics": {
    "/scan": {"bw": 38400.0, "bytes_per_msg": 3840, "rate": 10.0, "samples": 10},
    "/odom": {"bw": 2048.0, "bytes_per_msg": 256, "rate": 8.0, "samples": 10},
    "/cmd_vel": {"bw": 480.0, "bytes_per_msg": 48, "rate": 10.0, "samples": 10}
  },
  "no_data": [],
  "count": 3
}
```

`bw` is bytes/s. `bytes_per_msg` is mean serialised message size. Topics that produced fewer than 2 messages appear in `no_data`. Single-topic error:
```json
{"error": "Fewer than 2 messages received within 10.0s on '/camera/image_raw'"}
```

---

## topics delay `<topic>` [options]

Measure the end-to-end latency between a message's `header.stamp` and the wall clock at receipt. Requires messages with a `std_msgs/Header` field.

**ROS 2 CLI equivalent:** `ros2 topic delay /topic`

| Argument | Required | Description |
|----------|----------|-------------|
| `topic` | Yes | Topic name |

| Option | Default | Description |
|--------|---------|-------------|
| `--window N` | `10` | Number of latency samples to collect |
| `--timeout SECONDS` | `10` | Max wait time |

```bash
python3 {baseDir}/scripts/ros2_cli.py topics delay /odom
python3 {baseDir}/scripts/ros2_cli.py topics delay /scan --window 20
python3 {baseDir}/scripts/ros2_cli.py topics delay /camera/image_raw --window 5 --timeout 15
```

Output:
```json
{
  "topic": "/odom",
  "mean_delay": 0.003241,
  "min_delay": 0.001823,
  "max_delay": 0.005012,
  "std_dev": 0.000891,
  "samples": 10
}
```

All delay values in seconds. Error if no `header.stamp`:
```json
{"error": "Messages on '/cmd_vel' have no header.stamp field"}
```

---

## services list / services ls

List all available services.

**Aliases:** `services ls`

**ROS 2 CLI equivalent:** `ros2 service list -t`

```bash
python3 {baseDir}/scripts/ros2_cli.py services list
python3 {baseDir}/scripts/ros2_cli.py services ls
```

Output:
```json
{
  "services": ["/clear", "/kill", "/reset", "/spawn", "/turtle1/set_pen", "/turtle1/teleport_absolute"],
  "types": ["std_srvs/Empty", "turtlesim/Kill", "std_srvs/Empty", "turtlesim/Spawn", "turtlesim/SetPen", "turtlesim/TeleportAbsolute"],
  "count": 6
}
```

---

## services type `<service>`

Get the type of a specific service.

**ROS 2 CLI equivalent:** `ros2 service type /service`

| Argument | Required | Description |
|----------|----------|-------------|
| `service` | Yes | Service name (e.g. `/spawn`, `/reset`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py services type /spawn
python3 {baseDir}/scripts/ros2_cli.py services type /reset
```

Output:
```json
{"service": "/spawn", "type": "turtlesim/Spawn"}
```

---

## services details `<service>` / services info `<service>`

Get service details including type, request fields, and response fields.

**Aliases:** `services info`

**ROS 2 CLI equivalent:** `ros2 service info /service`

| Argument | Required | Description |
|----------|----------|-------------|
| `service` | Yes | Service name |

| Option | Default | Description |
|--------|---------|-------------|
| `--verbose` / `-v` | false | Include QoS profiles and endpoint node info (Lyrical Luth and newer only) |

```bash
python3 {baseDir}/scripts/ros2_cli.py services details /spawn
python3 {baseDir}/scripts/ros2_cli.py services info /spawn
python3 {baseDir}/scripts/ros2_cli.py services details /turtle1/set_pen
python3 {baseDir}/scripts/ros2_cli.py services info /my_service --verbose   # Lyrical+ only
```

Output:
```json
{
  "service": "/spawn",
  "type": "turtlesim/Spawn",
  "request": {"x": 0.0, "y": 0.0, "theta": 0.0, "name": ""},
  "response": {"name": ""}
}
```

Output with `--verbose` (Lyrical Luth and newer):
```json
{
  "service": "/my_service",
  "type": "std_srvs/srv/SetBool",
  "request": {"data": false},
  "response": {"success": false, "message": ""},
  "servers": [
    {
      "node_name": "my_node",
      "node_namespace": "/",
      "qos": {
        "reliability": "ReliabilityPolicy.RELIABLE",
        "durability": "DurabilityPolicy.VOLATILE",
        "history": "HistoryPolicy.KEEP_LAST",
        "depth": 10
      }
    }
  ],
  "clients": [
    {"node_name": "caller_node", "node_namespace": "/"}
  ]
}
```

If `--verbose` is used on a pre-Lyrical distro, a `"verbose_note"` key is returned instead of `"servers"`/`"clients"` with an explanation.

---

## services call `<service>` `<json_request>` [options]

Call a service with a JSON request payload and return the response.

**ROS 2 CLI equivalent:** `ros2 service call /service turtlesim/srv/Spawn '{"x": 3.0}'`

| Argument | Required | Description |
|----------|----------|-------------|
| `service` | Yes | Service name |
| `json_request` | Yes | JSON string of the request arguments |

| Option | Default | Description |
|--------|---------|-------------|
| `--service-type TYPE` | auto-detect | Override service type (e.g. `std_srvs/srv/SetBool`) |
| `--timeout SECONDS` | `5` | Timeout waiting for service availability and response |

```bash
# Reset turtlesim
python3 {baseDir}/scripts/ros2_cli.py services call /reset '{}'

# Spawn a new turtle
python3 {baseDir}/scripts/ros2_cli.py services call /spawn \
  '{"x":3.0,"y":3.0,"theta":0.0,"name":"turtle2"}'

# Set pen color
python3 {baseDir}/scripts/ros2_cli.py services call /turtle1/set_pen \
  '{"r":255,"g":0,"b":0,"width":3,"off":0}'

# Toggle a boolean service
python3 {baseDir}/scripts/ros2_cli.py services call /enable_motors \
  '{"data":true}' --service-type std_srvs/srv/SetBool

# With longer timeout for slow services
python3 {baseDir}/scripts/ros2_cli.py services call /run_calibration '{}' --timeout 30
```

Output:
```json
{"service": "/spawn", "success": true, "result": {"name": "turtle2"}}
```

Error (service not available):
```json
{"error": "Service not available: /spawn"}
```

---

## services find `<service_type>`

Find all services of a specific service type. Accepts both `/srv/` and short formats.

**ROS 2 CLI equivalent:** `ros2 service find std_srvs/srv/Empty`

| Argument | Required | Description |
|----------|----------|-------------|
| `service_type` | Yes | Service type (e.g. `std_srvs/srv/Empty` or `std_srvs/Empty`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py services find std_srvs/srv/Empty
python3 {baseDir}/scripts/ros2_cli.py services find std_srvs/Empty
python3 {baseDir}/scripts/ros2_cli.py services find turtlesim/srv/Spawn
```

Output:
```json
{
  "service_type": "std_srvs/srv/Empty",
  "services": ["/clear", "/reset"],
  "count": 2
}
```

---

## services echo `<service>` [options]

Collect service request/response events published on `<service>/_service_event` and return them all together. Requires service introspection to be explicitly enabled on both the client and server via `configure_introspection()`. A single service call produces at least 2 events (client-request + server-response).

**ROS 2 CLI equivalent:** `ros2 service echo /service` (Jazzy+)

| Argument | Required | Description |
|----------|----------|-------------|
| `service` | Yes | Service name (e.g. `/spawn`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `30` | Collection window in seconds (command exits after this, returning all events collected) |
| `--duration SECONDS` | _(none)_ | Same as `--timeout` but takes precedence when both are supplied |
| `--max-messages N` / `--max-events N` | _(unlimited)_ | Stop early after receiving this many events |

**Note:** This command requires service introspection to be enabled on the server/client:
```python
node.configure_introspection(
    clock, qos_profile, ServiceIntrospectionState.CONTENTS  # or METADATA
)
```

```bash
# Default: collect all events for 30 s — start BEFORE making the service call
python3 {baseDir}/scripts/ros2_cli.py services echo /spawn

# Longer window for slower workflows
python3 {baseDir}/scripts/ros2_cli.py services echo /spawn --timeout 60

# Stop as soon as 2 events are received (one request + one response)
python3 {baseDir}/scripts/ros2_cli.py services echo /emergency_stop --max-messages 2

# Fixed duration window
python3 {baseDir}/scripts/ros2_cli.py services echo /spawn --duration 10
```

Output:
```json
{
  "service": "/spawn",
  "event_topic": "/spawn/_service_event",
  "collected_count": 2,
  "events": [
    {"info": {}, "request": [{"x": 3.0, "y": 3.0, "theta": 0.0, "name": ""}], "response": []},
    {"info": {}, "request": [], "response": [{"name": "turtle2"}]}
  ]
}
```

Error (introspection not enabled):
```json
{
  "error": "No service event topic found: /spawn/_service_event",
  "hint": "Service introspection must be enabled on the server/client via configure_introspection(clock, qos, ServiceIntrospectionState.METADATA or CONTENTS)."
}
```

---

## nodes list / nodes ls

List all active ROS 2 nodes.

**Aliases:** `nodes ls`

**ROS 2 CLI equivalent:** `ros2 node list`

```bash
python3 {baseDir}/scripts/ros2_cli.py nodes list
python3 {baseDir}/scripts/ros2_cli.py nodes ls
```

Output:
```json
{
  "nodes": ["/turtlesim", "/ros2cli"],
  "count": 2
}
```

---

## nodes details `<node>` / nodes info `<node>`

Get node details: publishers, subscribers, services, action servers, and action clients.

**Aliases:** `nodes info`

**ROS 2 CLI equivalent:** `ros2 node info /node`

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name (e.g. `/turtlesim`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py nodes details /turtlesim
python3 {baseDir}/scripts/ros2_cli.py nodes info /turtlesim
python3 {baseDir}/scripts/ros2_cli.py nodes details /robot_state_publisher
```

Output:
```json
{
  "node": "/turtlesim",
  "publishers": ["/turtle1/color_sensor", "/turtle1/pose", "/rosout"],
  "subscribers": ["/turtle1/cmd_vel"],
  "services": ["/clear", "/kill", "/reset", "/spawn", "/turtle1/set_pen"],
  "action_servers": ["/turtle1/rotate_absolute"],
  "action_clients": []
}
```

---

## params list `<node>` / params ls `<node>`

List all parameters for a specific node.

**Aliases:** `params ls`

**ROS 2 CLI equivalent:** `ros2 param list /node`

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name (e.g. `/turtlesim`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py params list /turtlesim
python3 {baseDir}/scripts/ros2_cli.py params ls /turtlesim
python3 {baseDir}/scripts/ros2_cli.py params list /robot_state_publisher --timeout 10
```

Output:
```json
{
  "node": "/turtlesim",
  "parameters": ["/turtlesim:background_r", "/turtlesim:background_g", "/turtlesim:background_b", "/turtlesim:use_sim_time"],
  "count": 4
}
```

---

## params get `<node:param_name>` or `<node> <param_name>`

Get a parameter value. Accepts either colon-separated or space-separated format.

**ROS 2 CLI equivalent:** `ros2 param get /turtlesim background_r`

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Node name with `:param_name` suffix, or just the node name when using space format |
| `param_name` | No | Parameter name (when using space-separated format) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
# Colon format
python3 {baseDir}/scripts/ros2_cli.py params get /turtlesim:background_r

# Space-separated format
python3 {baseDir}/scripts/ros2_cli.py params get /base_controller base_frame_id

python3 {baseDir}/scripts/ros2_cli.py params get /turtlesim:use_sim_time
python3 {baseDir}/scripts/ros2_cli.py params get /turtlesim background_g --timeout 10
```

Output:
```json
{"name": "/turtlesim:background_r", "value": "69", "exists": true}
```

---

## params set `<node:param_name>` `<value>` or `<node> <param_name> <value>`

Set one or more parameter values. Accepts colon-separated or space-separated format. Pass additional `name=value` pairs after the first to set multiple parameters in a single call (Lyrical Luth feature — works on all distros).

**ROS 2 CLI equivalent:** `ros2 param set /turtlesim background_r 255`

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Node name with `:param_name` suffix, or just the node name |
| `value` | Yes | New value (colon format) |
| `param_name` | No | Parameter name (space format) |
| `extra_value` | No | Value to set (space format); additional `name=value` pairs for multi-set |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |
| `--type TYPE` | auto-detect | Force value type: `bool`, `int`, `float`, or `str`. Use when the inferred type is wrong (e.g. `"123"` should be a string). |

```bash
# Colon format (single)
python3 {baseDir}/scripts/ros2_cli.py params set /turtlesim:background_r 255

# Space-separated format (single)
python3 {baseDir}/scripts/ros2_cli.py params set /base_controller base_frame_id base_link_new

# Force type (Lyrical+ multi-param set feature — works on all distros)
python3 {baseDir}/scripts/ros2_cli.py params set /turtlesim:name_param 123 --type str

# Multi-pair: set background_r, background_g, and background_b in one call
python3 {baseDir}/scripts/ros2_cli.py params set /turtlesim:background_r 255 \
  /turtlesim:background_g 0 /turtlesim:background_b 0
```

Single-pair output:
```json
{"name": "/turtlesim:background_r", "value": "255", "success": true}
```

Multi-pair output:
```json
{
  "results": [
    {"name": "/turtlesim:background_r", "value": "255", "success": true},
    {"name": "/turtlesim:background_g", "value": "0", "success": true},
    {"name": "/turtlesim:background_b", "value": "0", "success": true}
  ]
}
```

Read-only parameter:
```json
{"name": "/base_controller:base_frame_id", "value": "base_link_new", "success": false, "error": "Parameter is read-only and cannot be changed at runtime", "read_only": true}
```

---

## params get-all-nodes `<param_name>` [options]

Query every running node for a single parameter by exact name. Returns the value from each node that has the parameter, and lists nodes where it is not set. Useful for checking `use_sim_time` or any other cross-node parameter without knowing which nodes own it.

**ROS 2 CLI equivalent:** No direct equivalent — replaces `ros2 param get` × N nodes. Related to Lyrical Luth's `--all-nodes` param query feature.

| Argument | Required | Description |
|----------|----------|-------------|
| `param_name` | Yes | Exact parameter name to search for (e.g. `use_sim_time`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Per-node service call timeout |

```bash
# Check use_sim_time across all nodes
python3 {baseDir}/scripts/ros2_cli.py params get-all-nodes use_sim_time

# Check a controller parameter across all nodes
python3 {baseDir}/scripts/ros2_cli.py params get-all-nodes max_vel_x
```

Output:
```json
{
  "param": "use_sim_time",
  "nodes": {
    "/turtlesim": "False",
    "/robot_state_publisher": "False",
    "/controller_manager": "False"
  },
  "count": 3,
  "not_set": ["/some_node_without_it"]
}
```

`nodes` maps node name → string-formatted value for every node that has the parameter. `not_set` lists nodes contacted but that do not have the parameter. Nodes that timed out are omitted silently.

---

## params describe `<node:param_name>` or `<node> <param_name>`

Describe a parameter's type, description, and constraints via the `DescribeParameters` service.

**ROS 2 CLI equivalent:** `ros2 param describe /turtlesim background_r`

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Node name with `:param_name` suffix, or node name alone |
| `param_name` | No | Parameter name (space-separated format) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py params describe /turtlesim:background_r
python3 {baseDir}/scripts/ros2_cli.py params describe /turtlesim background_r
python3 {baseDir}/scripts/ros2_cli.py params describe /base_controller base_frame_id --timeout 10
```

Output:
```json
{
  "name": "/turtlesim:background_r",
  "type": "integer",
  "description": "",
  "read_only": false,
  "dynamic_typing": false,
  "additional_constraints": ""
}
```

---

## params dump `<node>` [options]

Export all parameters for a node as a flat `{param_name: value}` dict. Internally calls `ListParameters` then `GetParameters`.

**ROS 2 CLI equivalent:** `ros2 param dump /turtlesim`

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name (e.g. `/turtlesim`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py params dump /turtlesim
python3 {baseDir}/scripts/ros2_cli.py params dump /robot_state_publisher --timeout 10
```

Output:
```json
{
  "node": "/turtlesim",
  "parameters": {
    "background_r": 69,
    "background_g": 86,
    "background_b": 255,
    "use_sim_time": false
  }
}
```

---

## params load `<node>` `<json_or_file>` [options]

Bulk-set parameters on a node from a JSON string or a JSON file path. Each parameter is set via `SetParameters`. Reports per-parameter success/failure.

**ROS 2 CLI equivalent:** `ros2 param load /turtlesim /path/to/params.yaml`

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name |
| `params` | Yes | JSON string `{"param": value}` or path to a JSON file |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
# From JSON string
python3 {baseDir}/scripts/ros2_cli.py params load /turtlesim \
  '{"background_r":255,"background_g":0,"background_b":0}'

# From a JSON file
python3 {baseDir}/scripts/ros2_cli.py params load /turtlesim /tmp/turtlesim_params.json

python3 {baseDir}/scripts/ros2_cli.py params load /base_controller \
  '{"max_vel_x":1.5,"max_vel_theta":2.0}' --timeout 10
```

Output:
```json
{
  "node": "/turtlesim",
  "results": [
    {"name": "background_r", "value": 255, "success": true},
    {"name": "background_g", "value": 0, "success": true},
    {"name": "background_b", "value": 0, "success": true}
  ],
  "loaded": 3,
  "failed": 0
}
```

---

## params delete `<node>` `<param_name>` [`<extra_names>` ...] [options]

Delete one or more parameters from a node. ROS 2 has no `DeleteParameters` service; this command uses `SetParameters` with `PARAMETER_NOT_SET` (type 0) to undeclare each parameter. Nodes launched with `allow_undeclare_parameters=False` (the default) or read-only parameters will reject the request and return an error reason.

**ROS 2 CLI equivalent:** `ros2 param delete /turtlesim background_r`

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Node name |
| `param_name` | Yes | First parameter name to delete |
| `extra_names` | No | Additional parameter names to delete in one call |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
# Delete one parameter
python3 {baseDir}/scripts/ros2_cli.py params delete /turtlesim background_r

# Delete multiple parameters in one call
python3 {baseDir}/scripts/ros2_cli.py params delete /turtlesim background_r background_g background_b

python3 {baseDir}/scripts/ros2_cli.py params delete /base_controller max_vel_x --timeout 10
```

Output (success):
```json
{"node": "/turtlesim", "results": [{"name": "background_r", "success": true}], "count": 1}
```

Output (rejected — node disallows undeclaring):
```json
{"node": "/turtlesim", "results": [{"name": "background_r", "success": false, "error": "Node rejected deletion (parameter may be read-only or undeclaring is not allowed)"}], "count": 1}
```

---

## params find `<pattern>` [options]

Search all running nodes (or a specific node) for parameters whose names contain `<pattern>` (case-insensitive substring match). Fetches the value of each matching parameter. Use pattern `all` or `*` to return every parameter on every node.

**Use this instead of:** `nodes list` → `params list <node>` × N → manual grep. Automates the full cross-node scan required by Rule 0 velocity-limit discovery.

| Argument | Required | Description |
|----------|----------|-------------|
| `pattern` | Yes | Substring to match against parameter names (case-insensitive). Use `all` or `*` to return everything. |

| Option | Default | Description |
|--------|---------|-------------|
| `--node NODE` | (all nodes) | Restrict search to a single node |
| `--timeout SECONDS` | `10` | Per-node service timeout |

```bash
# Find all velocity-related params across all nodes
python3 {baseDir}/scripts/ros2_cli.py params find vel

# Find limit params on a specific node
python3 {baseDir}/scripts/ros2_cli.py params find limit --node /base_controller

# Dump all params from all nodes
python3 {baseDir}/scripts/ros2_cli.py params find all
```

**Output (matches found):**
```json
{
  "pattern": "vel",
  "node_filter": null,
  "matches": [
    {"node": "/base_controller", "param": "max_vel_x", "full_name": "/base_controller:max_vel_x", "value": "0.5"},
    {"node": "/teleop_node", "param": "scale_linear_vel", "full_name": "/teleop_node:scale_linear_vel", "value": "0.3"}
  ],
  "count": 2
}
```

**Output (no matches):**
```json
{"pattern": "vel", "node_filter": null, "matches": [], "count": 0, "error": "No parameters matching 'vel' found on any node"}
```

---

## actions list / actions ls

List all available action servers.

**Aliases:** `actions ls`

**ROS 2 CLI equivalent:** `ros2 action list -t`

```bash
python3 {baseDir}/scripts/ros2_cli.py actions list
python3 {baseDir}/scripts/ros2_cli.py actions ls
```

Output:
```json
{
  "actions": ["/turtle1/rotate_absolute"],
  "count": 1
}
```

---

## actions details `<action>` / actions info `<action>`

Get action details including goal, result, and feedback field structures.

**Aliases:** `actions info`

**ROS 2 CLI equivalent:** `ros2 action info /action`

| Argument | Required | Description |
|----------|----------|-------------|
| `action` | Yes | Action server name |

```bash
python3 {baseDir}/scripts/ros2_cli.py actions details /turtle1/rotate_absolute
python3 {baseDir}/scripts/ros2_cli.py actions info /turtle1/rotate_absolute
python3 {baseDir}/scripts/ros2_cli.py actions details /navigate_to_pose
```

Output:
```json
{
  "action": "/turtle1/rotate_absolute",
  "action_type": "turtlesim/action/RotateAbsolute",
  "goal": {"theta": 0.0},
  "result": {"delta": 0.0},
  "feedback": {"remaining": 0.0}
}
```

---

## actions type `<action>`

Get the type of an action server. Resolves the type by inspecting the `/_action/feedback` topic and stripping the `_FeedbackMessage` suffix.

**ROS 2 CLI equivalent:** Shown in `ros2 action info /action` output

| Argument | Required | Description |
|----------|----------|-------------|
| `action` | Yes | Action server name |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Max wait time |

```bash
python3 {baseDir}/scripts/ros2_cli.py actions type /turtle1/rotate_absolute
python3 {baseDir}/scripts/ros2_cli.py actions type /navigate_to_pose
```

Output:
```json
{"action": "/turtle1/rotate_absolute", "type": "turtlesim/action/RotateAbsolute"}
```

Error (not found):
```json
{"error": "Action '/turtle1/rotate_absolute' not found in the ROS graph"}
```

---

## actions send `<action>` `<json_goal>` [options]

Send an action goal and wait for the result. Optionally collects intermediate feedback messages.

**ROS 2 CLI equivalent:** `ros2 action send_goal /action turtlesim/action/RotateAbsolute '{"theta": 3.14}'`

| Argument | Required | Description |
|----------|----------|-------------|
| `action` | Yes | Action server name |
| `json_goal` | Yes | JSON string of the goal arguments |

| Option | Default | Description |
|--------|---------|-------------|
| `--feedback` | off | Collect feedback messages during execution; adds `feedback_msgs` to output |
| `--timeout SECONDS` | `30` | Timeout waiting for result |

```bash
# Basic goal
python3 {baseDir}/scripts/ros2_cli.py actions send /turtle1/rotate_absolute \
  '{"theta":3.14}'

# With feedback collection
python3 {baseDir}/scripts/ros2_cli.py actions send /turtle1/rotate_absolute \
  '{"theta":3.14}' --feedback

# Navigate to pose (Nav2)
python3 {baseDir}/scripts/ros2_cli.py actions send /navigate_to_pose \
  '{"pose":{"header":{"frame_id":"map"},"pose":{"position":{"x":1.0,"y":0.0,"z":0.0},"orientation":{"w":1.0}}}}' \
  --timeout 120 --feedback
```

Output (without `--feedback`):
```json
{
  "action": "/turtle1/rotate_absolute",
  "success": true,
  "goal_id": "goal_1709312000000",
  "result": {"delta": -1.584}
}
```

Output (with `--feedback`):
```json
{
  "action": "/turtle1/rotate_absolute",
  "success": true,
  "goal_id": "goal_1709312000000",
  "result": {"delta": -1.584},
  "feedback_msgs": [
    {"remaining": 2.1},
    {"remaining": 1.4},
    {"remaining": 0.0}
  ]
}
```

Error (timeout):
```json
{
  "action": "/turtle1/rotate_absolute",
  "goal_id": "goal_1709312000000",
  "success": false,
  "error": "Timeout after 30.0s"
}
```

---

## actions cancel `<action>` [options]

Cancel all in-flight goals on an action server. Sends a `CancelGoal` request with zero UUID and zero timestamp — per the ROS 2 spec, this cancels all goals.

**ROS 2 CLI equivalent:** No direct equivalent (requires custom scripting with `action_msgs`)

| Argument | Required | Description |
|----------|----------|-------------|
| `action` | Yes | Action server name |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py actions cancel /turtle1/rotate_absolute
python3 {baseDir}/scripts/ros2_cli.py actions cancel /navigate_to_pose
python3 {baseDir}/scripts/ros2_cli.py actions cancel /navigate_to_pose --timeout 10
```

Output:
```json
{
  "action": "/turtle1/rotate_absolute",
  "return_code": 0,
  "cancelled_goals": 0
}
```

`return_code`: 0 = success, 1 = rejected, 2 = unknown goal, 3 = goal already terminated.

Error (server not available):
```json
{"error": "Action server '/turtle1/rotate_absolute' not available"}
```

---

## actions echo `<action>` [options]

Echo live action feedback and status messages from an action server. Subscribes to `<action>/_action/feedback` and (if available) `<action>/_action/status`. No introspection required — these are standard action topics.

**ROS 2 CLI equivalent:** `ros2 action echo /action`

| Argument | Required | Description |
|----------|----------|-------------|
| `action` | Yes | Action server name |

| Option | Default | Description |
|--------|---------|-------------|
| `--duration SECONDS` | _(none)_ | Collect feedback for this many seconds; without this, returns first feedback message |
| `--max-messages N` / `--max-msgs N` | `100` | Maximum feedback messages to collect (only with `--duration`) |
| `--timeout SECONDS` | `5` | Timeout waiting for first feedback message |

```bash
# Wait for first feedback message
python3 {baseDir}/scripts/ros2_cli.py actions echo /turtle1/rotate_absolute

# Collect feedback for 10 seconds while a goal is running
python3 {baseDir}/scripts/ros2_cli.py actions echo /navigate_to_pose --duration 10

# Collect up to 20 feedback messages with a 30-second window
python3 {baseDir}/scripts/ros2_cli.py actions echo /navigate_to_pose \
  --duration 30 --max-messages 20
```

Output (single feedback):
```json
{
  "action": "/turtle1/rotate_absolute",
  "feedback": {"feedback": {"remaining": 1.42}}
}
```

Output (duration mode):
```json
{
  "action": "/navigate_to_pose",
  "collected_count": 5,
  "feedback": [
    {"feedback": {"current_pose": {}, "distance_remaining": 2.1}},
    {"feedback": {"current_pose": {}, "distance_remaining": 1.7}}
  ],
  "status": [{"status_list": [{"status": 2}]}]
}
```

Error (action server not found):
```json
{"error": "Action server not found: /turtle1/rotate_absolute"}
```

---

## actions find `<action_type>`

Find all action servers of a specific action type. Accepts both `/action/` and short formats (normalised for comparison). Mirrors `topics find` and `services find`.

**ROS 2 CLI equivalent:** `ros2 action find turtlesim/action/RotateAbsolute`

| Argument | Required | Description |
|----------|----------|-------------|
| `action_type` | Yes | Action type (e.g. `turtlesim/action/RotateAbsolute` or `turtlesim/RotateAbsolute`) |

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECONDS` | `5` | Timeout in seconds for action server discovery |

```bash
python3 {baseDir}/scripts/ros2_cli.py actions find turtlesim/action/RotateAbsolute
python3 {baseDir}/scripts/ros2_cli.py actions find turtlesim/RotateAbsolute
python3 {baseDir}/scripts/ros2_cli.py actions find nav2_msgs/action/NavigateToPose
```

Output:
```json
{
  "action_type": "turtlesim/action/RotateAbsolute",
  "actions": ["/turtle1/rotate_absolute"],
  "count": 1
}
```

No matches:
```json
{"action_type": "turtlesim/action/RotateAbsolute", "actions": [], "count": 0}
```

---

## lifecycle nodes

List all managed (lifecycle) nodes in the ROS 2 graph. Discovers nodes by scanning for services of type `lifecycle_msgs/srv/GetState`.

**ROS 2 CLI equivalent:** `ros2 lifecycle nodes`

| Argument | Required | Description |
|----------|----------|-------------|
| (none) | — | No arguments needed |

Example:
```bash
python3 scripts/ros2_cli.py lifecycle nodes
```

Output:
```json
{
  "managed_nodes": [
    "/lifecycle_node",
    "/camera_driver"
  ],
  "count": 2
}
```

Output (no managed nodes found):
```json
{"managed_nodes": [], "count": 0}
```

---

## lifecycle list

List available states and transitions for one or all managed (lifecycle) nodes.

**Aliases:** `lifecycle ls`

**ROS 2 CLI equivalent:** `ros2 lifecycle list <node>`

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | No | Node name (e.g. `/my_lifecycle_node`). If omitted, queries all managed nodes. |
| `--timeout` | No | Timeout per node in seconds (default: 5) |

Examples:
```bash
# Single node
python3 scripts/ros2_cli.py lifecycle list /my_lifecycle_node
python3 scripts/ros2_cli.py lifecycle ls /my_lifecycle_node

# All managed nodes (no argument)
python3 scripts/ros2_cli.py lifecycle list
python3 scripts/ros2_cli.py lifecycle ls
```

Output (single node):
```json
{
  "node": "/my_lifecycle_node",
  "available_states": [
    {"id": 0, "label": "unknown"},
    {"id": 1, "label": "unconfigured"},
    {"id": 2, "label": "inactive"},
    {"id": 3, "label": "active"},
    {"id": 4, "label": "finalized"}
  ],
  "available_transitions": [
    {
      "id": 1,
      "label": "configure",
      "start_state": {"id": 1, "label": "unconfigured"},
      "goal_state": {"id": 2, "label": "inactive"}
    },
    {
      "id": 5,
      "label": "shutdown",
      "start_state": {"id": 1, "label": "unconfigured"},
      "goal_state": {"id": 4, "label": "finalized"}
    }
  ]
}
```

Output (all nodes — no argument):
```json
{
  "nodes": [
    {
      "node": "/lifecycle_node",
      "available_states": [...],
      "available_transitions": [...]
    }
  ]
}
```

Output (error):
```json
{"node": "/my_lifecycle_node", "error": "Lifecycle service not available for /my_lifecycle_node"}
```

---

## lifecycle get

Get the current lifecycle state of a managed node.

**ROS 2 CLI equivalent:** `ros2 lifecycle get <node>`

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name (e.g. `/my_lifecycle_node`) |
| `--timeout` | No | Timeout in seconds (default: 5) |

Example:
```bash
python3 scripts/ros2_cli.py lifecycle get /my_lifecycle_node
```

Output:
```json
{"node": "/my_lifecycle_node", "state_id": 1, "state_label": "unconfigured"}
```

Common state IDs:
| ID | Label |
|----|-------|
| 0 | unknown |
| 1 | unconfigured |
| 2 | inactive |
| 3 | active |
| 4 | finalized |

Output (error):
```json
{"error": "Lifecycle service not available for /my_lifecycle_node. Is it a managed node?"}
```

---

## lifecycle set

Trigger a lifecycle state transition on a managed node. Accepts a transition by label (preferred) or numeric ID.

When a label is given, the node's available transitions are queried first to resolve the correct numeric ID. This ensures correctness because the `ChangeState` service dispatches on ID, not label. Numeric IDs bypass the extra lookup.

**ROS 2 CLI equivalent:** `ros2 lifecycle set <node> <transition>`

| Argument | Required | Description |
|----------|----------|-------------|
| `node` | Yes | Node name (e.g. `/my_lifecycle_node`) |
| `transition` | Yes | Transition label (e.g. `configure`) or numeric ID (e.g. `1`) |
| `--timeout` | No | Timeout in seconds (default: 5) |

Common transition labels:

| Label | ID | Start state | Goal state |
|-------|----|-------------|------------|
| `configure` | 1 | unconfigured | inactive |
| `cleanup` | 2 | inactive | unconfigured |
| `activate` | 3 | inactive | active |
| `deactivate` | 4 | active | inactive |
| `unconfigured_shutdown` | 5 | unconfigured | finalized |
| `inactive_shutdown` | 6 | inactive | finalized |
| `active_shutdown` | 7 | active | finalized |

Short forms are accepted via two-way fuzzy matching against the available transitions for the node's current state:
- **Suffix match** — input matches the end of a label: `shutdown` → `unconfigured_shutdown` / `inactive_shutdown` / `active_shutdown`
- **Prefix match** — input matches the start of a label: `unconfigured` → `unconfigured_shutdown`, `inactive` → `inactive_shutdown`, `active` → `active_shutdown`

Exact match is always tried first; suffix then prefix are fallbacks.

Examples:
```bash
# By label (preferred) — resolves to the correct transition ID automatically
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node configure
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node activate
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node deactivate
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node cleanup
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node shutdown               # suffix-matched to current state
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node unconfigured_shutdown  # explicit full label

# By numeric ID — no extra round-trip to the node
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node 3   # activate
python3 scripts/ros2_cli.py lifecycle set /my_lifecycle_node 5   # shutdown from unconfigured
```

Output (success):
```json
{"node": "/my_lifecycle_node", "transition": "configure", "success": true}
```

Output (failure — invalid transition for current state):
```json
{"node": "/my_lifecycle_node", "transition": "activate", "success": false}
```

Output (error — node not reachable):
```json
{"error": "Lifecycle service not available for /my_lifecycle_node. Is it a managed node?"}
```

Output (error — unknown label, with available options):
```json
{"error": "Unknown transition 'go'. Available: ['configure', 'unconfigured_shutdown']"}
```

---

## control list-controller-types

List all controller types available in the pluginlib registry with their base classes.

| Option | Required | Description |
|--------|----------|-------------|
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control list-controller-types
python3 scripts/ros2_cli.py control list-controller-types --controller-manager /my_robot/controller_manager
```

Output (success):
```json
{
  "controller_types": [
    {"type": "joint_trajectory_controller/JointTrajectoryController", "base_class": "controller_interface::ControllerInterface"},
    {"type": "diff_drive_controller/DiffDriveController", "base_class": "controller_interface::ControllerInterface"}
  ],
  "count": 2
}
```
Output (error):
```json
{"error": "Controller manager service not available: /controller_manager/list_controller_types. Is the controller manager running?"}
```

---

## control list-controllers

List all loaded controllers, their type, and current state.

| Option | Required | Description |
|--------|----------|-------------|
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control list-controllers
```

Output (success):
```json
{
  "controllers": [
    {"name": "joint_trajectory_controller", "type": "joint_trajectory_controller/JointTrajectoryController", "state": "active"},
    {"name": "joint_state_broadcaster", "type": "joint_state_broadcaster/JointStateBroadcaster", "state": "active"}
  ],
  "count": 2
}
```
Output (error):
```json
{"error": "Timeout calling /controller_manager/list_controllers"}
```

---

## control list-hardware-components

List hardware components (actuator, sensor, system) managed by ros2_control.

| Option | Required | Description |
|--------|----------|-------------|
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control list-hardware-components
```

Output (success):
```json
{
  "hardware_components": [
    {"name": "RRBotSystemPositionOnly", "type": "system", "state": {"id": 3, "label": "active"}}
  ],
  "count": 1
}
```
Output (error):
```json
{"error": "Controller manager service not available: /controller_manager/list_hardware_components. Is the controller manager running?"}
```

---

## control list-hardware-interfaces

List all available command and state interfaces.

| Option | Required | Description |
|--------|----------|-------------|
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control list-hardware-interfaces
```

Output (success):
```json
{
  "command_interfaces": [{"name": "joint1/position", "is_available": true, "is_claimed": true}],
  "state_interfaces": [{"name": "joint1/position", "is_available": true}]
}
```
Output (error):
```json
{"error": "Controller manager service not available: /controller_manager/list_hardware_interfaces. Is the controller manager running?"}
```

---

## control load-controller

Load a controller plugin by name into the controller manager.

**Alias:** `load`

| Option | Required | Description |
|--------|----------|-------------|
| name | Yes | Controller name (positional) |
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control load-controller joint_trajectory_controller
python3 scripts/ros2_cli.py control load joint_trajectory_controller
```

Output (success):
```json
{"controller": "joint_trajectory_controller", "ok": true}
```
Output (error):
```json
{"error": "Controller manager service not available: /controller_manager/load_controller. Is the controller manager running?"}
```

---

## control unload-controller

Unload a stopped controller from the controller manager.

**Alias:** `unload`

| Option | Required | Description |
|--------|----------|-------------|
| name | Yes | Controller name (positional) |
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control unload-controller joint_trajectory_controller
python3 scripts/ros2_cli.py control unload joint_trajectory_controller
```

Output (success):
```json
{"controller": "joint_trajectory_controller", "ok": true}
```
Output (error):
```json
{"controller": "joint_trajectory_controller", "ok": false}
```

---

## control configure-controller

Configure a loaded controller, driving it from the `unconfigured` state to `inactive`. This calls the `ConfigureController` service directly, which surfaces any `on_configure()` errors that `SwitchController`'s built-in auto-configure silently hides.

Use this command when a controller is stuck in `unconfigured` after `load-controller`, or when you need to confirm that configuration succeeds before attempting to activate.

**ROS 2 CLI equivalent:** `ros2 control configure_controller <name>`

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Controller name (positional) |
| `--controller-manager` | No | Controller manager node name (default: /controller_manager) |
| `--timeout` | No | Service call timeout in seconds (default: 5.0) |

Recommended workflow — explicit load → configure → activate:
```bash
# 1. Load the controller (brings it to unconfigured)
python3 scripts/ros2_cli.py control load-controller joint_trajectory_controller

# 2. Configure it (unconfigured → inactive); errors from on_configure() are visible here
python3 scripts/ros2_cli.py control configure-controller joint_trajectory_controller

# 3. Activate it (inactive → active)
python3 scripts/ros2_cli.py control set-controller-state joint_trajectory_controller active
```

Output (success):
```json
{"controller": "joint_trajectory_controller", "ok": true}
```
Output (failure — on_configure() returned error):
```json
{"controller": "joint_trajectory_controller", "ok": false}
```
Output (error — service not available):
```json
{"error": "Controller manager service not available: /controller_manager/configure_controller. Is the controller manager running?"}
```

---

## control reload-controller-libraries

Reload all controller plugin libraries in the controller manager.

| Option | Required | Description |
|--------|----------|-------------|
| --force-kill | No | Force kill controllers before reloading |
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control reload-controller-libraries
python3 scripts/ros2_cli.py control reload-controller-libraries --force-kill
```

Output (success):
```json
{"ok": true, "force_kill": false}
```
Output (error):
```json
{"error": "Controller manager service not available: /controller_manager/reload_controller_libraries. Is the controller manager running?"}
```

---

## control set-controller-state

Activate or deactivate a single controller via SwitchController (STRICT mode).

| Option | Required | Description |
|--------|----------|-------------|
| name | Yes | Controller name (positional) |
| state | Yes | Target state: `active` or `inactive` (positional) |
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control set-controller-state joint_trajectory_controller active
python3 scripts/ros2_cli.py control set-controller-state joint_trajectory_controller inactive
```

Output (success):
```json
{"controller": "joint_trajectory_controller", "state": "active", "ok": true}
```
Output (error):
```json
{"controller": "joint_trajectory_controller", "state": "active", "ok": false}
```

---

## control set-hardware-component-state

Drive a hardware component through its lifecycle state machine.

| Option | Required | Description |
|--------|----------|-------------|
| name | Yes | Hardware component name (positional) |
| state | Yes | Target lifecycle state: `unconfigured`, `inactive`, `active`, or `finalized` (positional) |
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control set-hardware-component-state my_robot active
python3 scripts/ros2_cli.py control set-hardware-component-state my_robot inactive
```

Output (success):
```json
{"component": "my_robot", "ok": true, "actual_state": {"id": 3, "label": "active"}}
```
Output (error):
```json
{"error": "Controller manager service not available: /controller_manager/set_hardware_component_state. Is the controller manager running?"}
```

---

## control switch-controllers

Atomically activate and/or deactivate multiple controllers in a single call.

| Option | Required | Description |
|--------|----------|-------------|
| --activate | No | Controllers to activate (space-separated list) |
| --deactivate | No | Controllers to deactivate (space-separated list) |
| --strictness | No | `BEST_EFFORT` or `STRICT` (default: BEST_EFFORT) |
| --activate-asap | No | Activate controllers as soon as possible |
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control switch-controllers \
    --activate joint_trajectory_controller --deactivate cartesian_controller
python3 scripts/ros2_cli.py control switch-controllers --activate ctrl_a ctrl_b --strictness STRICT
```

Output (success):
```json
{
  "activate": ["joint_trajectory_controller"],
  "deactivate": ["cartesian_controller"],
  "strictness": "BEST_EFFORT",
  "ok": true
}
```
Output (error):
```json
{"error": "Timeout calling /controller_manager/switch_controller"}
```

---

## control view-controller-chains

Generate a Graphviz diagram of loaded chained controllers, save as PDF to `.artifacts/`, and optionally send to Discord.

Requires graphviz: `sudo apt install graphviz`

| Option | Required | Description |
|--------|----------|-------------|
| --output | No | Output PDF filename saved in .artifacts/ (default: controller_diagram.pdf) |
| --channel-id | No | Discord channel ID; if provided, sends the PDF via discord_tools |
| --config | No | Path to nanobot config for Discord (default: ~/.nanobot/config.json) |
| --controller-manager | No | Controller manager node name (default: /controller_manager) |
| --timeout | No | Service call timeout in seconds (default: 5.0) |

Example:
```bash
python3 scripts/ros2_cli.py control view-controller-chains
python3 scripts/ros2_cli.py control view-controller-chains --output my_diagram.pdf --channel-id 1234567890
```

Output (success):
```json
{
  "gv_path": "/path/to/.artifacts/controller_diagram.gv",
  "pdf_path": "/path/to/.artifacts/controller_diagram.pdf",
  "controllers": 3
}
```
Output (success with Discord):
```json
{
  "gv_path": "/path/to/.artifacts/controller_diagram.gv",
  "pdf_path": "/path/to/.artifacts/controller_diagram.pdf",
  "controllers": 3,
  "discord_sent": true
}
```
Output (graphviz not installed):
```json
{
  "gv_path": "/path/to/.artifacts/controller_diagram.gv",
  "pdf_path": null,
  "warning": "graphviz 'dot' not installed; .gv written but PDF not generated. Install with: sudo apt install graphviz",
  "controllers": 3
}
```
Output (error):
```json
{"error": "Controller manager service not available: /controller_manager/list_controllers. Is the controller manager running?"}
```

---

## doctor / wtf

Run ROS 2 system health checks. `wtf` is an exact alias for `doctor` (same flags, same subcommands, same output).

**ROS 2 CLI equivalent:** `ros2 doctor` / `ros2 wtf`

### doctor (default — health check)

| Option | Default | Description |
|--------|---------|-------------|
| `--report` / `-r` | false | Include all report sections in the output |
| `--report-failed` / `-rf` | false | Include report sections for failed checks only |
| `--exclude-packages` / `-ep` | false | Skip package-related checks |
| `--include-warnings` / `-iw` | false | Treat warnings as failures in the overall summary |

```bash
python3 {baseDir}/scripts/ros2_cli.py doctor
python3 {baseDir}/scripts/ros2_cli.py doctor --include-warnings
python3 {baseDir}/scripts/ros2_cli.py doctor --report-failed -ep
python3 {baseDir}/scripts/ros2_cli.py wtf
```

Output (all passing):
```json
{
  "summary": {
    "total": 4,
    "passed": 4,
    "failed": 0,
    "warned": 0,
    "overall": "PASS"
  },
  "checks": [
    {"name": "network", "status": "PASS", "errors": 0, "warnings": 0},
    {"name": "platform", "status": "PASS", "errors": 0, "warnings": 0},
    {"name": "rmw", "status": "PASS", "errors": 0, "warnings": 0},
    {"name": "topic", "status": "PASS", "errors": 0, "warnings": 0}
  ]
}
```

Output (with warnings, `--report-failed` flag):
```json
{
  "summary": {
    "total": 4,
    "passed": 3,
    "failed": 0,
    "warned": 1,
    "overall": "WARN"
  },
  "checks": [
    {"name": "network", "status": "WARN", "errors": 0, "warnings": 1},
    {"name": "platform", "status": "PASS", "errors": 0, "warnings": 0},
    {"name": "rmw", "status": "PASS", "errors": 0, "warnings": 0},
    {"name": "topic", "status": "PASS", "errors": 0, "warnings": 0}
  ],
  "reports": []
}
```

Output (ros2doctor not installed):
```json
{"error": "No ros2doctor checkers found. Is ros2doctor installed? Source ROS 2 setup.bash."}
```

**Environment variables that affect ROS 2 health (Lyrical Luth additions):**

| Variable | Effect | When to use |
|----------|--------|-------------|
| `RCL_LOGGING_IMPLEMENTATION` | Swap the logging backend at runtime (`rcl_logging_spdlog` is the default; `rcl_logging_log4cxx` for structured log aggregation). | Node logs missing or in unexpected format: unset this variable or set it explicitly to `rcl_logging_spdlog`. |
| `TRACETOOLS_RUNTIME_DISABLE` | Set to `1` to disable tracetools instrumentation globally at runtime. | Suppress tracing overhead when `ros2 trace` is not in use (Lyrical+ only). |
| `TRACETOOLS_STATUS_OVERRIDE` | Force tracing status reporting (`enabled`/`disabled`). | Debug tracing configuration issues without restarting nodes. |

---

### doctor hello

Check cross-host connectivity by publishing on a ROS 2 topic and sending UDP multicast packets simultaneously, then reporting which other hosts responded.

**ROS 2 CLI equivalent:** `ros2 doctor hello`

| Option | Default | Description |
|--------|---------|-------------|
| `--topic TOPIC` / `-t` | `/canyouhearme` | Topic to publish and subscribe on |
| `--timeout SECS` / `-to` | `10.0` | How long to listen for responses (seconds) |

```bash
python3 {baseDir}/scripts/ros2_cli.py doctor hello
python3 {baseDir}/scripts/ros2_cli.py doctor hello --timeout 5 --topic /ros2_hello
python3 {baseDir}/scripts/ros2_cli.py wtf hello
```

Output (other hosts heard):
```json
{
  "published": {
    "topic": "/canyouhearme",
    "multicast": "225.0.0.1:49150",
    "message": "hello, it's me my-robot"
  },
  "ros_topic_heard_from": ["hello, it's me other-robot"],
  "multicast_heard_from": ["192.168.1.42"],
  "total_ros_hosts": 1,
  "total_multicast_hosts": 1
}
```

Output (no other hosts):
```json
{
  "published": {
    "topic": "/canyouhearme",
    "multicast": "225.0.0.1:49150",
    "message": "hello, it's me my-robot"
  },
  "ros_topic_heard_from": [],
  "multicast_heard_from": [],
  "total_ros_hosts": 0,
  "total_multicast_hosts": 0
}
```

---

## multicast send

Send one UDP multicast datagram to a multicast group. Uses pure Python `socket` — no ROS 2 required.

**ROS 2 CLI equivalent:** `ros2 multicast send`

| Option | Default | Description |
|--------|---------|-------------|
| `--group GROUP` / `-g` | `225.0.0.1` | Multicast group address |
| `--port PORT` / `-p` | `49150` | UDP port |

```bash
python3 {baseDir}/scripts/ros2_cli.py multicast send
python3 {baseDir}/scripts/ros2_cli.py multicast send --group 225.0.0.1 --port 49150
```

Output:
```json
{
  "sent": {
    "group": "225.0.0.1",
    "port": 49150,
    "message": "Hello, multicast!"
  }
}
```

---

## multicast receive

Listen for UDP multicast packets and return all received within the timeout window. Uses pure Python `socket` — no ROS 2 required.

**ROS 2 CLI equivalent:** `ros2 multicast receive`

| Option | Default | Description |
|--------|---------|-------------|
| `--group GROUP` / `-g` | `225.0.0.1` | Multicast group address |
| `--port PORT` / `-p` | `49150` | UDP port |
| `--timeout SECS` / `-t` | `5.0` | How long to listen in seconds |

```bash
python3 {baseDir}/scripts/ros2_cli.py multicast receive
python3 {baseDir}/scripts/ros2_cli.py multicast receive --timeout 10
python3 {baseDir}/scripts/ros2_cli.py multicast receive --group 225.0.0.1 --port 49150 --timeout 5
```

Output (packets received):
```json
{
  "received": [
    {"from": "192.168.1.42", "message": "Hello, multicast!"}
  ],
  "total": 1,
  "group": "225.0.0.1",
  "port": 49150,
  "timeout": 5.0
}
```

Output (nothing received):
```json
{
  "received": [],
  "total": 0,
  "group": "225.0.0.1",
  "port": 49150,
  "timeout": 5.0
}
```

---

## tf

TF2 transform utilities for querying, listing, and monitoring coordinate frame transforms.

### tf tree [options]

Subscribe to `/tf` and `/tf_static` for a short duration and output the full frame hierarchy as an ASCII tree. Use this to understand the robot's transform topology before any spatial operation.

| Option | Default | Description |
|--------|---------|-------------|
| `--duration SECONDS` | `2.0` | How long to collect TF messages |

```bash
python3 {baseDir}/scripts/ros2_cli.py tf tree
python3 {baseDir}/scripts/ros2_cli.py tf tree --duration 3
```

**Output:**
```json
{
  "frames": ["world", "odom", "base_link", "laser_link", "camera_link"],
  "root_frames": ["world"],
  "tree": "world\n└── odom\n    └── base_link\n        ├── laser_link\n        └── camera_link",
  "transform_count": 4
}
```

**No frames received:**
```json
{"error": "No TF frames received within 2.0s — is a TF publisher running?"}
```

### tf validate [options]

Collect TF transforms and check for structural problems: cycles, frames with multiple parents, and empty trees. Run this before any TF-dependent operation when the tree is unfamiliar or after a node restart.

| Option | Default | Description |
|--------|---------|-------------|
| `--duration SECONDS` | `2.0` | How long to collect TF messages |

```bash
python3 {baseDir}/scripts/ros2_cli.py tf validate
```

**Output (valid):**
```json
{
  "valid": true,
  "frames": ["world", "odom", "base_link", "laser_link"],
  "issues": [],
  "warnings": ["Frame 'laser_link' has no children — leaf node (expected for sensors)"]
}
```

**Output (cycle detected):**
```json
{
  "valid": false,
  "frames": ["odom", "base_link", "odom"],
  "issues": ["Cycle detected involving frame 'odom'", "Frame 'base_link' has multiple parents: odom, world"],
  "warnings": []
}
```

### tf list / tf ls

List all available coordinate frames.

```bash
python3 {baseDir}/scripts/ros2_cli.py tf list
```

### tf lookup / tf get `<source>` `<target>`

Lookup transform between two frames.

| Argument | Required | Description |
|----------|----------|-------------|
| `source` | Yes | Source frame |
| `target` | Yes | Target frame |

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--timeout`, `-t` | No | 5.0 | Timeout in seconds |

```bash
python3 {baseDir}/scripts/ros2_cli.py tf lookup base_link map
```

**Output:**
```json
{
  "source_frame": "base_link",
  "target_frame": "map",
  "translation": {"x": 1.0, "y": 0.0, "z": 0.0},
  "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
  "euler": {"roll": 0.0, "pitch": 0.0, "yaw": 0.0},
  "euler_degrees": {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}
}
```

### tf echo `<source>` `<target>`

Continuously echo transforms.

| Argument | Required | Description |
|----------|----------|-------------|
| `source` | Yes | Source frame |
| `target` | Yes | Target frame |

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--timeout`, `-t` | No | 5.0 | Timeout per lookup |
| `--count`, `-n` | No | 5 | Number of echos |
| `--once` | No | false | Echo once (equivalent to `--count 1`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py tf echo base_link map --count 10
```

### tf monitor `<frame>`

Monitor transform updates for a specific frame.

| Argument | Required | Description |
|----------|----------|-------------|
| `frame` | Yes | Frame to monitor |

```bash
python3 {baseDir}/scripts/ros2_cli.py tf monitor base_link --count 5
```

### tf static `<x>` `<y>` `<z>` `<roll>` `<pitch>` `<yaw>` `<from_frame>` `<to_frame>`

Publish static transform. Runs in tmux session.

| Argument | Required | Description |
|----------|----------|-------------|
| `x` | Yes | Translation x |
| `y` | Yes | Translation y |
| `z` | Yes | Translation z |
| `roll` | Yes | Rotation roll (radians) |
| `pitch` | Yes | Rotation pitch (radians) |
| `yaw` | Yes | Rotation yaw (radians) |
| `from_frame` | Yes | Source frame |
| `to_frame` | Yes | Target frame |

```bash
python3 {baseDir}/scripts/ros2_cli.py tf static 0 0 0 0 0 0 base_link odom
```

### tf euler-from-quaternion `<x>` `<y>` `<z>` `<w>`

Convert quaternion to Euler angles (radians).

```bash
python3 {baseDir}/scripts/ros2_cli.py tf euler-from-quaternion 0 0 0 1
```

### tf quaternion-from-euler `<roll>` `<pitch>` `<yaw>`

Convert Euler angles to quaternion (radians).

```bash
python3 {baseDir}/scripts/ros2_cli.py tf quaternion-from-euler 0 0 1.57
```

### tf euler-from-quaternion-deg `<x>` `<y>` `<z>` `<w>`

Convert quaternion to Euler angles (degrees).

```bash
python3 {baseDir}/scripts/ros2_cli.py tf euler-from-quaternion-deg 0 0 0 1
```

### tf quaternion-from-euler-deg `<roll>` `<pitch>` `<yaw>`

Convert Euler angles to quaternion (degrees).

```bash
python3 {baseDir}/scripts/ros2_cli.py tf quaternion-from-euler-deg 0 0 90
```

### tf transform-point `<target>` `<source>` `<x>` `<y>` `<z>`

Transform a point from source to target frame.

```bash
python3 {baseDir}/scripts/ros2_cli.py tf transform-point map base_link 1 0 0
```

### tf transform-vector `<target>` `<source>` `<x>` `<y>` `<z>`

Transform a vector from source to target frame.

```bash
python3 {baseDir}/scripts/ros2_cli.py tf transform-vector map base_link 1 0 0
```

---

## launch new `<package>` `<launch_file>` [args...]

Run a ROS 2 launch file in a tmux session. System ROS is assumed to be already sourced. The local workspace is sourced automatically if found.

**Auto-detect features:**
- Launch arguments are validated against the launch file's available arguments
- Invalid/unknown arguments show a warning and are ignored
- Partial argument names are auto-matched (e.g., "mock" → "use_mock")

**Workspace sourcing:** If the launch file is in a local workspace, the skill automatically sources it. Set `ROS2_LOCAL_WS` environment variable if the workspace is not in the default search paths (`~/ros2_ws`, `~/colcon_ws`, `~/dev_ws`, `~/workspace`, `~/ros2`).

**Lyrical Luth launch additions (available in launch files on Lyrical+ only):**
- **New substitutions:** `StringJoinSubstitution(values, delimiter)` — concatenates a list of strings; `PathJoinSubstitution(values)` — joins path segments (replaces manual `[FindPackageShare(...), "subdir", "file.yaml"]` patterns).
- **Log actions:** `LogInfo(msg)`, `LogWarn(msg)`, `LogError(msg)`, `LogDebug(msg)` — emit structured messages from inside a launch file at the appropriate log level. More precise than `LogInfo` with a `condition` argument for runtime-conditional logging.

These are launch-file authoring features, not `ros2_cli.py` flags. They affect launch files you write or inspect, not how `launch new` is invoked.

**Discovery workflow:** Resolve the launch file location before running:
1. **Path A (profile loaded):** check `summary.launch_files` and `summary.packages` for the package + launch file. No live calls needed for naming.
2. **Path B (no profile):** `ros2 pkg list` — find available packages; `ros2 pkg files <package>` — find launch files in a package.
3. Either path: `launch run` will fail-fast if the file does not exist, so a `launch list` pre-check is optional, not required.

| Argument | Required | Description |
|----------|----------|-------------|
| `package` | Yes | Package name containing the launch file |
| `launch_file` | Yes | Launch file name (e.g., `navigation2.launch.py`) |
| `args` | No | Additional launch arguments |

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--timeout SECONDS` | No | 30 | Timeout for launch to start |

**Run a launch file:**
```bash
python3 {baseDir}/scripts/ros2_cli.py launch new navigation2 navigation2.launch.py
```

**Run with arguments (exact match):**
```bash
python3 {baseDir}/scripts/ros2_cli.py launch new navigation2 navigation2.launch.py use_mock:=true map:=/maps/office.yaml
```

**Run with arguments (fuzzy-matched):**
```bash
# "mock" is not a real arg but "use_mock" is — it will be auto-matched and you'll be notified
python3 {baseDir}/scripts/ros2_cli.py launch new navigation2 navigation2.launch.py mock:=true
```

**Output (success, all args matched):**
```json
{
  "success": true,
  "session": "launch_navigation2_navigation2",
  "command": "ros2 launch navigation2 navigation2.launch.py use_mock:=true map:=/maps/office.yaml",
  "package": "navigation2",
  "launch_file": "navigation2.launch.py",
  "status": "running",
  "launch_args": ["use_mock:=true", "map:=/maps/office.yaml"]
}
```

**Output (fuzzy match applied):**
```json
{
  "success": true,
  "session": "launch_navigation2_navigation2",
  "command": "ros2 launch navigation2 navigation2.launch.py use_mock:=true",
  "package": "navigation2",
  "launch_file": "navigation2.launch.py",
  "status": "running",
  "launch_args": ["use_mock:=true"],
  "arg_notices": [
    "NOTICE: 'mock' not found — using closest match 'use_mock' instead. Passed as: use_mock:=true"
  ]
}
```

**Output (unknown arg — dropped, launch still proceeds):**
```json
{
  "success": true,
  "session": "launch_navigation2_navigation2",
  "command": "ros2 launch navigation2 navigation2.launch.py",
  "package": "navigation2",
  "launch_file": "navigation2.launch.py",
  "status": "running",
  "launch_args": [],
  "arg_notices": [
    "NOTICE: Argument 'nonexistent_arg' does not exist in this launch file and no similar argument was found. It was NOT passed. Available args: [map, use_mock, use_sim_time]"
  ]
}
```

Error (session already exists):
```json
{
  "error": "Session 'launch_navigation2_navigation2' already exists",
  "suggestion": "Use 'launch kill launch_navigation2_navigation2' to kill first",
  "session": "launch_navigation2_navigation2"
}
```

---

## launch list / launch ls `[keyword]`

Without a keyword, lists running launch sessions in tmux. With a keyword, searches all installed ROS 2 packages for launch files whose path contains the keyword (case-insensitive).

| Argument | Required | Description |
|----------|----------|-------------|
| `keyword` | No | Substring to search for in package names or launch file paths |

**List running sessions (no keyword):**
```bash
python3 {baseDir}/scripts/ros2_cli.py launch list
```

**Output (no keyword):**
```json
{
  "all_sessions": ["launch_navigation2_navigation2", "launch_turtlesim_turtlesim"],
  "launch_sessions": ["launch_navigation2_navigation2"],
  "launch_sessions_detail": [
    {
      "session": "launch_navigation2_navigation2",
      "command": "ros2 launch navigation2 navigation2.launch.py",
      "status": "running"
    }
  ]
}
```

**Search for launch files by keyword:**
```bash
python3 {baseDir}/scripts/ros2_cli.py launch list navigation
```

**Output (with keyword):**
```json
{
  "keyword": "navigation",
  "matches": [
    {
      "package": "navigation2",
      "launch_file": "navigation2.launch.py",
      "full_path": "/opt/ros/humble/share/navigation2/launch/navigation2.launch.py"
    },
    {
      "package": "nav2_bringup",
      "launch_file": "bringup_launch.py",
      "full_path": "/opt/ros/humble/share/nav2_bringup/launch/bringup_launch.py"
    }
  ],
  "count": 2
}
```

**Common keywords:**

| Intent | Keyword |
|--------|---------|
| Navigation stack | `navigation` or `nav2` |
| Robot description / URDF | `robot_description` or `urdf` |
| Teleop / joystick | `teleop` |
| Camera / sensors | `camera` or `sensor` |
| Control framework | `ros2_control` or `controller` |
| Simulation | `gazebo` or `sim` |

---

## launch kill `<session>`

Kill a running launch session.

| Argument | Required | Description |
|----------|----------|-------------|
| `session` | Yes | Session name to kill (must start with `launch_`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py launch kill launch_navigation2_navigation2
```

**Output:**
```json
{
  "success": true,
  "session": "launch_navigation2_navigation2",
  "message": "Session 'launch_navigation2_navigation2' killed"
}
```

---

## launch foxglove `[port]`

Launch foxglove_bridge in a tmux session. System ROS is assumed to be already sourced. The local workspace is sourced automatically if found.

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `port` | No | 8765 | Foxglove bridge port |

**Run foxglove_bridge:**
```bash
python3 {baseDir}/scripts/ros2_cli.py launch foxglove
```

**Run with custom port:**
```bash
python3 {baseDir}/scripts/ros2_cli.py launch foxglove 9000
```

**Output:**
```json
{
  "success": true,
  "session": "launch_foxglove_bridge_port8765",
  "command": "ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765",
  "package": "foxglove_bridge",
  "launch_file": "foxglove_bridge_launch.xml",
  "port": 8765,
  "status": "running"
}
```

Error (session already exists):
```json
{
  "error": "Session 'launch_foxglove_bridge_port8765' already exists",
  "suggestion": "Use 'launch restart launch_foxglove_bridge_port8765' to restart, or 'launch kill launch_foxglove_bridge_port8765' to kill first",
  "session": "launch_foxglove_bridge_port8765"
}
```

Error (package not found):
```json
{
  "error": "Package 'foxglove_bridge' not found",
  "suggestion": "Install for your ROS 2 distro with:\n  sudo apt install ros-$ROS_DISTRO-foxglove-bridge\n\nOr build from source:\n  git clone https://github.com/foxglove/ros2-foxglove-bridge.git",
  "current_distro": "jazzy"
}
```

Error (launch file not found):
```json
{
  "error": "Launch file 'foxglove_bridge_launch.xml' not found in foxglove_bridge package",
  "suggestion": "The foxglove_bridge package is installed but may be for a different ROS distro.\nCurrent distro: jazzy\n\nReinstall for your distro:\n  sudo apt install ros-jazzy-foxglove-bridge\n\nOr check installed packages:\n  dpkg -l | grep foxglove",
  "package_path": "/opt/ros/jazzy/share/foxglove_bridge"
}
```

---

## launch restart `<session>`

Restart a launch session. Kills the existing session and re-launches with the same parameters that were used originally. Works for all session types (both `launch` and `launch foxglove`).

Session metadata is saved when launching and used for restart.

| Argument | Required | Description |
|----------|----------|-------------|
| `session` | Yes | Session name to restart |

**Restart any launch session:**
```bash
# Restart a generic launch
python3 {baseDir}/scripts/ros2_cli.py launch restart launch_navigation2_navigation2

# Restart foxglove_bridge
python3 {baseDir}/scripts/ros2_cli.py launch restart launch_foxglove_bridge_port8765
```

**Output:**
```json
{
  "success": true,
  "session": "launch_navigation2_navigation2",
  "command": "ros2 launch navigation2 navigation2.launch.py",
  "status": "running",
  "message": "Session restarted"
}
```

Error (session not found):
```json
{
  "error": "Session 'launch_navigation2_navigation2' does not exist",
  "suggestion": "Use 'launch' to start a new session",
  "available_sessions": []
}
```

Error (no metadata):
```json
{
  "error": "No metadata found for session 'launch_navigation2_navigation2'",
  "suggestion": "Use 'launch' to start a fresh session",
  "session": "launch_navigation2_navigation2"
}
```

---

## run new `<package>` `<executable>` [args...]

Run a ROS 2 executable in a tmux session. System ROS is assumed to be already sourced. The local workspace is sourced automatically if found.

**Auto-detect:** Executable names are fuzzy-matched (e.g., "teleop" → "teleop_node").

**Workspace sourcing:** If the executable is in a local workspace, the skill automatically sources it. Set `ROS2_LOCAL_WS` environment variable if the workspace is not in the default search paths (`~/ros2_ws`, `~/colcon_ws`, `~/dev_ws`, `~/workspace`, `~/ros2`).

| Argument | Required | Description |
|----------|----------|-------------|
| `package` | Yes | Package name containing the executable |
| `executable` | Yes | Executable name (found in `lib/<package>/`) |
| `args` | No | Additional arguments |

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--presets NAME` | No | — | Comma-separated preset names to apply before running |
| `--params "k:=v"` | No | — | Inline parameters (comma-separated key:=value or key:value) |
| `--config-path PATH` | No | auto | Path to config directory |

**Run an executable:**
```bash
python3 {baseDir}/scripts/ros2_cli.py run new my_robot_pkg teleop
```

**Run with arguments:**
```bash
python3 {baseDir}/scripts/ros2_cli.py run new my_robot_pkg teleop --speed 1.0
```

**Run with parameters:**
```bash
python3 {baseDir}/scripts/ros2_cli.py run new my_robot_pkg teleop --params "speed:1.0,max_velocity:2.0"
```

**Run with presets:**
```bash
python3 {baseDir}/scripts/ros2_cli.py run new my_robot_pkg teleop --presets indoor
```

**Output:**
```json
{
  "success": true,
  "session": "run_my_robot_pkg_teleop",
  "command": "ros2 run my_robot_pkg teleop",
  "package": "my_robot_pkg",
  "executable": "teleop",
  "args": [],
  "status": "running"
}
```

Error (session already exists):
```json
{
  "error": "Session 'run_my_robot_pkg_teleop' already exists",
  "suggestion": "Use 'run restart run_my_robot_pkg_teleop' to restart, or 'run kill run_my_robot_pkg_teleop' to kill first",
  "session": "run_my_robot_pkg_teleop"
}
```

---

## run list / run ls

List running run sessions in tmux.

```bash
python3 {baseDir}/scripts/ros2_cli.py run list
```

**Output:**
```json
{
  "all_sessions": ["run_my_robot_pkg_teleop", "launch_navigation2_navigation2"],
  "run_sessions": ["run_my_robot_pkg_teleop"],
  "run_sessions_detail": [
    {
      "session": "run_my_robot_pkg_teleop",
      "command": "ros2 run my_robot_pkg teleop",
      "status": "running"
    }
  ]
}
```

---

## run kill `<session>`

Kill a running run session.

| Argument | Required | Description |
|----------|----------|-------------|
| `session` | Yes | Session name to kill (must start with `run_`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py run kill run_my_robot_pkg_teleop
```

**Output:**
```json
{
  "success": true,
  "session": "run_my_robot_pkg_teleop",
  "message": "Session 'run_my_robot_pkg_teleop' killed"
}
```

---

## run restart `<session>`

Restart a run session. Kills the existing session and re-launches with the same parameters.

| Argument | Required | Description |
|----------|----------|-------------|
| `session` | Yes | Session name to restart |

**Restart a run session:**
```bash
python3 {baseDir}/scripts/ros2_cli.py run restart run_my_robot_pkg_teleop
```

**Output:**
```json
{
  "success": true,
  "session": "run_my_robot_pkg_teleop",
  "command": "ros2 run my_robot_pkg teleop",
  "status": "running",
  "message": "Session restarted"
}
```

Error (session not found):
```json
{
  "error": "Session 'run_my_robot_pkg_teleop' does not exist",
  "suggestion": "Use 'run' to start a new session",
  "available_sessions": []
}
```

---

## interface list

List all interface types (messages, services, actions) installed on this ROS 2 system. Reads from the ament resource index — no running ROS 2 graph required.

**ROS 2 CLI equivalent:** `ros2 interface list`

| Argument | Required | Description |
|----------|----------|-------------|
| (none) | — | No arguments |

```bash
python3 {baseDir}/scripts/ros2_cli.py interface list
```

Output:
```json
{
  "messages": [
    "geometry_msgs/msg/Twist",
    "std_msgs/msg/Bool",
    "std_msgs/msg/String"
  ],
  "services": [
    "std_srvs/srv/Empty",
    "std_srvs/srv/SetBool"
  ],
  "actions": [
    "nav2_msgs/action/NavigateToPose"
  ],
  "total": 6
}
```

---

## interface show `<type>`

Show the field structure of a message, service, or action type. Accepts canonical formats (`pkg/msg/Name`, `pkg/srv/Name`, `pkg/action/Name`) and shorthand (`pkg/Name` — tries message, then service, then action).

**ROS 2 CLI equivalent:** `ros2 interface show <type>`

| Argument | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Interface type string |

```bash
python3 {baseDir}/scripts/ros2_cli.py interface show std_msgs/msg/String
python3 {baseDir}/scripts/ros2_cli.py interface show std_srvs/srv/SetBool
python3 {baseDir}/scripts/ros2_cli.py interface show nav2_msgs/action/NavigateToPose
python3 {baseDir}/scripts/ros2_cli.py interface show std_msgs/String
```

Output (message):
```json
{
  "type": "std_msgs/msg/String",
  "kind": "message",
  "fields": {"data": "string"}
}
```

Output (service):
```json
{
  "type": "std_srvs/srv/SetBool",
  "kind": "service",
  "request": {"data": "boolean"},
  "response": {"success": "boolean", "message": "string"}
}
```

Output (action):
```json
{
  "type": "nav2_msgs/action/NavigateToPose",
  "kind": "action",
  "goal": {
    "pose": "geometry_msgs/PoseStamped",
    "behavior_tree": "string"
  },
  "result": {"result": "nav2_msgs/NavigationResult"},
  "feedback": {
    "current_pose": "geometry_msgs/PoseStamped",
    "navigation_time": "builtin_interfaces/Duration",
    "number_of_recoveries": "int16",
    "distance_remaining": "float32"
  }
}
```

Output (unknown type):
```json
{"error": "Unknown interface type: bad_pkg/msg/Nope", "hint": "Use formats like std_msgs/msg/String, std_srvs/srv/SetBool, nav2_msgs/action/NavigateToPose, or shorthand std_msgs/String"}
```

---

## interface proto `<type>`

Show a default-value prototype of a message, service, or action type. Unlike `interface show` (which returns field type strings), `proto` instantiates the type with its default values — useful as a copy-paste template for `ros2 topic pub` payloads. Reads from the ament resource index — no running ROS 2 graph required.

**ROS 2 CLI equivalent:** `ros2 interface proto <type>`

| Argument | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Interface type string |

```bash
python3 {baseDir}/scripts/ros2_cli.py interface proto std_msgs/msg/String
python3 {baseDir}/scripts/ros2_cli.py interface proto geometry_msgs/msg/Twist
python3 {baseDir}/scripts/ros2_cli.py interface proto std_srvs/srv/SetBool
```

Output (message):
```json
{
  "type": "std_msgs/msg/String",
  "kind": "message",
  "proto": {"data": ""}
}
```

Output (nested message):
```json
{
  "type": "geometry_msgs/msg/Twist",
  "kind": "message",
  "proto": {
    "linear":  {"x": 0.0, "y": 0.0, "z": 0.0},
    "angular": {"x": 0.0, "y": 0.0, "z": 0.0}
  }
}
```

Output (service):
```json
{
  "type": "std_srvs/srv/SetBool",
  "kind": "service",
  "request":  {"data": false},
  "response": {"success": false, "message": ""}
}
```

---

## interface packages

List all packages that define at least one ROS 2 interface. Reads from the ament resource index — no running ROS 2 graph required.

**ROS 2 CLI equivalent:** `ros2 interface packages`

| Argument | Required | Description |
|----------|----------|-------------|
| (none) | — | No arguments |

```bash
python3 {baseDir}/scripts/ros2_cli.py interface packages
```

Output:
```json
{
  "packages": [
    "action_msgs",
    "builtin_interfaces",
    "geometry_msgs",
    "nav2_msgs",
    "rcl_interfaces",
    "sensor_msgs",
    "std_msgs",
    "std_srvs"
  ],
  "count": 8
}
```

---

## interface package `<package>`

List all interface types (messages, services, actions) defined by a single package. Reads from the ament resource index — no running ROS 2 graph required.

**ROS 2 CLI equivalent:** `ros2 interface package <package>`

| Argument | Required | Description |
|----------|----------|-------------|
| `package` | Yes | Package name (e.g. `std_msgs`, `geometry_msgs`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py interface package std_msgs
python3 {baseDir}/scripts/ros2_cli.py interface package geometry_msgs
```

Output:
```json
{
  "package": "std_msgs",
  "messages": [
    "std_msgs/msg/Bool",
    "std_msgs/msg/Float32",
    "std_msgs/msg/Int32",
    "std_msgs/msg/String"
  ],
  "services": [],
  "actions": [],
  "total": 4
}
```

Output (unknown package):
```json
{"error": "Package 'nonexistent_pkg' not found or has no interfaces"}
```

---

## bag info `<bag_path>`

Show metadata for a ROS 2 bag: duration, starting time, storage format, message count, and the topic list with per-topic message counts.

**No live ROS 2 graph required.** Parses `metadata.yaml` from the bag directory using the filesystem only. Works with any storage backend (`sqlite3`, `mcap`, etc.).

**ROS 2 CLI equivalent:** `ros2 bag info <bag_path>`

| Argument | Required | Description |
|----------|----------|-------------|
| `bag_path` | Yes | Path to a bag directory (containing `metadata.yaml`), or directly to the `metadata.yaml` file, or to any storage file inside the bag directory |

```bash
python3 {baseDir}/scripts/ros2_cli.py bag info /path/to/my_bag
python3 {baseDir}/scripts/ros2_cli.py bag info /path/to/my_bag/metadata.yaml
```

Output:
```json
{
  "bag_path": "/absolute/path/to/my_bag",
  "storage_identifier": "sqlite3",
  "duration": {
    "nanoseconds": 10000000000,
    "seconds": 10.0
  },
  "starting_time": {
    "nanoseconds_since_epoch": 1700000000000000000
  },
  "message_count": 1500,
  "topic_count": 3,
  "topics": [
    {
      "name": "/cmd_vel",
      "type": "geometry_msgs/msg/Twist",
      "serialization_format": "cdr",
      "offered_qos_profiles": "",
      "message_count": 100
    },
    {
      "name": "/odom",
      "type": "nav_msgs/msg/Odometry",
      "serialization_format": "cdr",
      "offered_qos_profiles": "",
      "message_count": 1000
    },
    {
      "name": "/scan",
      "type": "sensor_msgs/msg/LaserScan",
      "serialization_format": "cdr",
      "offered_qos_profiles": "",
      "message_count": 400
    }
  ]
}
```

Topics are sorted alphabetically by name. The optional `compression_format`, `compression_mode`, and `files` fields are included when present in the bag metadata.

Error (metadata not found):
```json
{
  "error": "metadata.yaml not found in '/path/to/dir'. Provide the path to a bag directory that contains metadata.yaml.",
  "hint": "Provide the path to a bag directory that contains metadata.yaml."
}
```

Error (PyYAML not installed):
```json
{"error": "PyYAML is required for bag info: pip install pyyaml"}
```

### Bag remote service control (Lyrical Luth and newer)

On Lyrical Luth and newer, `ros2 bag record` exposes ROS 2 services on the recording node that allow another node or agent to control an ongoing recording session remotely:

| Service | Type | Effect |
|---------|------|--------|
| `~/record` | `std_srvs/srv/Empty` | Start recording (if not already running) |
| `~/stop` | `std_srvs/srv/Empty` | Stop and finalise the current bag |
| `~/pause` | `std_srvs/srv/Empty` | Pause recording (messages buffered, not written) |
| `~/resume` | `std_srvs/srv/Empty` | Resume a paused recording |
| `~/split` | `std_srvs/srv/Empty` | Close the current bag file and open a new one |

The services are relative to the recording node's namespace (default `~` = the node's own namespace, typically `/ros2bag_…`). Discover the exact names with `services list` and use `services call` to invoke them:

```bash
# Discover the recording node's services
python3 {baseDir}/scripts/ros2_cli.py services list

# Pause an active recording
python3 {baseDir}/scripts/ros2_cli.py services call /ros2bag_record/pause '{}'

# Split to a new file
python3 {baseDir}/scripts/ros2_cli.py services call /ros2bag_record/split '{}'

# Stop the recording
python3 {baseDir}/scripts/ros2_cli.py services call /ros2bag_record/stop '{}'
```

These services are not available on Humble, Iron, Jazzy, or Kilted. On those distros, the recording node does not expose control services.

---

## ros2 trace (Lyrical Luth — native CLI only)

> **Not wrapped by ros2-skill.** Use the native `ros2 trace` CLI directly. ros2-skill does not provide a `trace` command.

`ros2 trace` gained two new modes in Lyrical Luth. Use the native CLI for these operations:

| Mode | Command | Effect |
|------|---------|--------|
| Snapshot | `ros2 trace snapshot` | Capture a point-in-time snapshot of the current trace buffer without stopping an ongoing session. |
| Dual-session | `ros2 trace --dual-session` | Run two simultaneous trace sessions — one for the agent and one for the robot hardware. Useful for correlating AI decision points with low-level actuator events. |

Set `TRACETOOLS_RUNTIME_DISABLE=1` to suppress all tracing overhead when `ros2 trace` is not in use.

---

## pkg list / pkg ls

List all ROS 2 packages installed on this system.

**No live ROS 2 graph required.** Reads the ament resource index from the filesystem.

**ROS 2 CLI equivalent:** `ros2 pkg list`

```bash
python3 {baseDir}/scripts/ros2_cli.py pkg list
python3 {baseDir}/scripts/ros2_cli.py pkg ls
```

Output:
```json
{
  "packages": [
    "ackermann_msgs",
    "action_msgs",
    "geometry_msgs",
    "...and many more..."
  ],
  "total": 312
}
```

---

## pkg prefix `<package>`

Output the install prefix path for a package.

**No live ROS 2 graph required.**

**ROS 2 CLI equivalent:** `ros2 pkg prefix <package>`

| Argument | Required | Description |
|----------|----------|-------------|
| `package` | Yes | Package name (e.g. `nav2_bringup`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py pkg prefix nav2_bringup
python3 {baseDir}/scripts/ros2_cli.py pkg prefix turtlesim
```

Output:
```json
{"package": "turtlesim", "prefix": "/opt/ros/humble"}
```

Error (package not found):
```json
{"error": "Package 'bad_pkg' not found. Is it installed and sourced?"}
```

---

## pkg executables `<package>`

List all executable files provided by a package.

**No live ROS 2 graph required.** Walks `<prefix>/lib/<package>/` and returns files with the executable bit set.

**ROS 2 CLI equivalent:** `ros2 pkg executables <package>`

| Argument | Required | Description |
|----------|----------|-------------|
| `package` | Yes | Package name (e.g. `turtlesim`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py pkg executables turtlesim
python3 {baseDir}/scripts/ros2_cli.py pkg executables demo_nodes_cpp
```

Output:
```json
{
  "package": "turtlesim",
  "executables": ["draw_square", "mimic", "turtle_teleop_key", "turtlesim_node"],
  "total": 4,
  "lib_dir": "/opt/ros/humble/lib/turtlesim"
}
```

If the package has no executables (e.g. a message-only package), `executables` is `[]` and `total` is `0`.

Error (package not found):
```json
{"error": "Package 'bad_pkg' not found. Is it installed and sourced?"}
```

---

## pkg xml `<package>`

Output the `package.xml` manifest of a package.

**No live ROS 2 graph required.** Reads `<prefix>/share/<package>/package.xml` from the filesystem.

**ROS 2 CLI equivalent:** `ros2 pkg xml <package>`

| Argument | Required | Description |
|----------|----------|-------------|
| `package` | Yes | Package name (e.g. `std_msgs`) |

```bash
python3 {baseDir}/scripts/ros2_cli.py pkg xml std_msgs
python3 {baseDir}/scripts/ros2_cli.py pkg xml turtlesim
```

Output:
```json
{
  "package": "std_msgs",
  "path": "/opt/ros/humble/share/std_msgs/package.xml",
  "xml": "<?xml version=\"1.0\"?>\n<package format=\"3\">...</package>\n"
}
```

Error (package not found):
```json
{"error": "Package 'bad_pkg' not found. Is it installed and sourced?"}
```

---

## component types

List all registered `rclcpp` composable node types installed on this system.

**No live ROS 2 graph required.** Reads the `rclcpp_components` ament resource index from the filesystem. Each package that exports composable nodes registers a resource file whose lines are component class names (e.g. `my_pkg::MyNode`).

**ROS 2 CLI equivalent:** `ros2 component types`

```bash
python3 {baseDir}/scripts/ros2_cli.py component types
```

Output:
```json
{
  "components": [
    {"package": "composition", "type_name": "composition::Talker"},
    {"package": "composition", "type_name": "composition::Listener"},
    {"package": "composition", "type_name": "composition::NodeLikeListener"},
    {"package": "my_pkg", "type_name": "my_pkg::MyNode"}
  ],
  "total": 4,
  "packages": ["composition", "my_pkg"]
}
```

Components are sorted by package name, then by declaration order within each package's resource file. The `packages` field is an alphabetically sorted list of unique package names. If any package's resource file cannot be read, a `warnings` array is included with per-package error details — remaining packages are still enumerated.

Output (with per-package warning):
```json
{
  "components": [{"package": "good_pkg", "type_name": "good_pkg::GoodNode"}],
  "total": 1,
  "packages": ["good_pkg"],
  "warnings": [{"package": "bad_pkg", "error": "disk error"}]
}
```

Error (`ament_index_python` not installed):
```json
{
  "error": "ament_index_python is required: pip install ament-index-python",
  "detail": "No module named 'ament_index_python'"
}
```

---

## component list

List all running component containers and their loaded components. Discovers containers by scanning the live graph for `composition_interfaces/srv/ListNodes` services.

**ROS 2 CLI equivalent:** `ros2 component list`

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECS` | `5.0` | Seconds to wait per container service |

```bash
python3 {baseDir}/scripts/ros2_cli.py component list
python3 {baseDir}/scripts/ros2_cli.py component ls
```

Output:
```json
{
  "containers": [
    {
      "container": "/my_container",
      "component_count": 2,
      "components": [
        {"unique_id": 1, "full_node_name": "/my_container/talker"},
        {"unique_id": 2, "full_node_name": "/my_container/listener"}
      ]
    }
  ],
  "total_containers": 1,
  "total_components": 2
}
```

No containers running:
```json
{"containers": [], "total_containers": 0, "total_components": 0, "hint": "No component containers found. Start one with: ros2 run rclcpp_components component_container"}
```

---

## component load `<container>` `<package_name>` `<plugin_name>` [options]

Load a composable node into a running component container.

**ROS 2 CLI equivalent:** `ros2 component load <container> <package> <plugin>`

| Option | Default | Description |
|--------|---------|-------------|
| `--node-name NAME` | `""` | Override the loaded node's name |
| `--node-namespace NS` | `""` | Override the loaded node's namespace |
| `--remap RULE [...]` | `[]` | Remap rules (e.g. `/from:=/to`) |
| `--log-level LEVEL` | `0` | Log level for the loaded node (uint8: 0=unset, 10=DEBUG, 20=INFO, 30=WARN, 40=ERROR, 50=FATAL) |
| `--timeout SECS` | `5.0` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py component load /my_container demo_nodes_cpp demo_nodes_cpp::Talker
python3 {baseDir}/scripts/ros2_cli.py component load /my_container demo_nodes_cpp demo_nodes_cpp::Talker --node-name my_talker
```

Output:
```json
{
  "success": true,
  "container": "/my_container",
  "package_name": "demo_nodes_cpp",
  "plugin_name": "demo_nodes_cpp::Talker",
  "full_node_name": "/my_container/talker",
  "unique_id": 1
}
```

---

## component unload `<container>` `<unique_id>` [options]

Unload a composable node from a component container by its unique ID (from `component load` or `component list`).

**ROS 2 CLI equivalent:** `ros2 component unload <container> <unique_id>`

| Option | Default | Description |
|--------|---------|-------------|
| `--timeout SECS` | `5.0` | Service call timeout |

```bash
python3 {baseDir}/scripts/ros2_cli.py component unload /my_container 1
```

Output:
```json
{"success": true, "container": "/my_container", "unique_id": 1}
```

---

## component standalone `<package_name>` `<plugin_name>` [options]

Run a composable node in its own standalone container. Starts a fresh `rclcpp_components/component_container` in a tmux session and immediately loads the specified plugin into it. The container node is named `standalone_<plugin_class>` (derived from the plugin name, e.g. `demo_nodes_cpp::Talker` → `/standalone_talker`).

**ROS 2 CLI equivalent:** `ros2 component standalone <package> <plugin>`

**Requires:** tmux, rclcpp_components, composition_interfaces

| Option | Default | Description |
|--------|---------|-------------|
| `--container-type TYPE` | `component_container` | Container executable (`component_container`, `component_container_mt`, `component_container_isolated`) |
| `--node-name NAME` | `""` | Override the loaded node's name |
| `--node-namespace NS` | `""` | Override the loaded node's namespace |
| `--remap RULE [...]` | `[]` | Remap rules (e.g. `/from:=/to`) |
| `--log-level LEVEL` | `0` | Log level for the loaded node (uint8: 0=unset, 10=DEBUG, 20=INFO, 30=WARN, 40=ERROR, 50=FATAL) |
| `--timeout SECS` | `10.0` | Total timeout for container start + component load |

> **Optional output key:** `warning` is present when a local workspace is detected but not yet built — the command still proceeds.

```bash
python3 {baseDir}/scripts/ros2_cli.py component standalone demo_nodes_cpp demo_nodes_cpp::Talker
```

**Output (success):**
```json
{
  "success": true,
  "session": "comp_demo_nodes_cpp_standalone_talker",
  "container": "/standalone_talker",
  "container_type": "component_container",
  "package_name": "demo_nodes_cpp",
  "plugin_name": "demo_nodes_cpp::Talker",
  "full_node_name": "/talker",
  "unique_id": 1,
  "status": "running"
}
```

> **Note:** `full_node_name` is returned verbatim from the `LoadNode` service. With `component_container` (default) the node runs in the global namespace (e.g. `/talker`). With `component_container_isolated` it is namespaced under the container (e.g. `/standalone_talker/talker`).

**Output (session already exists):**
```json
{
  "error": "Session 'comp_demo_nodes_cpp_standalone_talker' already exists",
  "suggestion": "Use 'component kill comp_demo_nodes_cpp_standalone_talker' to kill it first",
  "session": "comp_demo_nodes_cpp_standalone_talker"
}
```

The session can be killed with `component kill <session>` when the container is no longer needed.

---

## component kill `<session>`

Kill a standalone component container session. Terminates the tmux session and removes its metadata entry. Only accepts sessions with the `comp_` prefix.

**No live ROS 2 graph required.**

```bash
python3 {baseDir}/scripts/ros2_cli.py component kill comp_demo_nodes_cpp_standalone_talker
```

**Output (success):**
```json
{
  "success": true,
  "session": "comp_demo_nodes_cpp_standalone_talker",
  "message": "Session 'comp_demo_nodes_cpp_standalone_talker' killed"
}
```

**Output (wrong session type):**
```json
{
  "error": "Session 'run_my_node' is not a comp session",
  "hint": "Comp sessions start with 'comp_'"
}
```

**Output (session not found):**
```json
{
  "error": "Session 'comp_demo_nodes_cpp_standalone_talker' does not exist",
  "available_sessions": []
}
```

---

## daemon status

Check whether the ROS 2 daemon is running.

**No live ROS 2 graph required.** Reads the domain ID from `ROS_DOMAIN_ID` (default 0). Queries the `ros2cli` Python API first; falls back to PID file discovery in `~/.ros/` if `ros2cli` is not available.

**ROS 2 CLI equivalent:** `ros2 daemon status`

```bash
python3 {baseDir}/scripts/ros2_cli.py daemon status
```

Output (running):
```json
{"status": "running", "domain_id": 0, "pid": 12345}
```

Output (not running):
```json
{"status": "not_running", "domain_id": 0}
```

---

## daemon start

Start the ROS 2 daemon if it is not already running.

**No live ROS 2 graph required.** Uses `ros2cli.daemon.spawn_daemon()`. Idempotent: returns `already_running` immediately if the daemon is already up.

**ROS 2 CLI equivalent:** `ros2 daemon start`

```bash
python3 {baseDir}/scripts/ros2_cli.py daemon start
```

Output (started):
```json
{"status": "started", "domain_id": 0, "pid": 12345}
```

Output (already running):
```json
{"status": "already_running", "domain_id": 0, "pid": 12345}
```

Output (ros2cli unavailable):
```json
{
  "error": "ros2cli Python package not available",
  "hint": "Install ros2cli or run 'ros2 daemon start' in a shell",
  "domain_id": 0
}
```

---

## daemon stop

Stop the ROS 2 daemon.

**No live ROS 2 graph required.** Uses `ros2cli.daemon.shutdown_daemon()` if available; falls back to `SIGTERM` via PID file. Idempotent: returns `not_running` immediately if the daemon is already stopped.

**ROS 2 CLI equivalent:** `ros2 daemon stop`

```bash
python3 {baseDir}/scripts/ros2_cli.py daemon stop
```

Output (stopped):
```json
{"status": "stopped", "domain_id": 0}
```

Output (not running):
```json
{"status": "not_running", "domain_id": 0}
```

Output (stop signal sent, daemon still exiting):
```json
{
  "status": "stop_requested",
  "domain_id": 0,
  "note": "Daemon may take a moment to exit",
  "pid": 12345
}
```

---

## Command Quick Reference

### 1. Explore a Robot System

```bash
python3 {baseDir}/scripts/ros2_cli.py version
python3 {baseDir}/scripts/ros2_cli.py topics list
python3 {baseDir}/scripts/ros2_cli.py nodes list
python3 {baseDir}/scripts/ros2_cli.py services list
python3 {baseDir}/scripts/ros2_cli.py actions list

# Discover installed packages and what they provide
python3 {baseDir}/scripts/ros2_cli.py pkg list
python3 {baseDir}/scripts/ros2_cli.py pkg prefix turtlesim
python3 {baseDir}/scripts/ros2_cli.py pkg executables turtlesim
python3 {baseDir}/scripts/ros2_cli.py pkg xml turtlesim

# Find a topic by type, then inspect it
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/msg/Twist
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/msg/TwistStamped
# → get the discovered topic name, then:
python3 {baseDir}/scripts/ros2_cli.py topics type <discovered_topic>
python3 {baseDir}/scripts/ros2_cli.py interface proto <confirmed_type>
```

### 2. Move a Robot

**Emergency stop:**
```bash
python3 {baseDir}/scripts/ros2_cli.py estop
```

### 3. Read Sensor Data

**Always use auto-discovery first** to find the correct sensor topics.

```bash
# Step 1: Discover sensor topics by message type
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/LaserScan
python3 {baseDir}/scripts/ros2_cli.py topics find nav_msgs/msg/Odometry
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/JointState
# → record each discovered topic name

# Step 2: Subscribe to discovered topics (use the names from Step 1, not hardcoded names)
python3 {baseDir}/scripts/ros2_cli.py topics subscribe <LASER_TOPIC> --duration 3
python3 {baseDir}/scripts/ros2_cli.py topics subscribe <ODOM_TOPIC> --duration 10 --max-messages 50
python3 {baseDir}/scripts/ros2_cli.py topics subscribe <JOINT_STATE_TOPIC> --duration 5
```

### 4. Use Services

**Always use auto-discovery first** to find available services and their request/response structures.

```bash
# Step 1: Discover available services
python3 {baseDir}/scripts/ros2_cli.py services list

# Step 2: Find services by type (optional)
python3 {baseDir}/scripts/ros2_cli.py services find std_srvs/srv/Empty
python3 {baseDir}/scripts/ros2_cli.py services find turtlesim/srv/Spawn

# Step 3: Get service request/response structure
python3 {baseDir}/scripts/ros2_cli.py services details /spawn

# Step 4: Call the service with properly-structured payload
python3 {baseDir}/scripts/ros2_cli.py services call /spawn \
  '{"x":3.0,"y":3.0,"theta":0.0,"name":"turtle2"}'
```

### 5. Actions

**Always use auto-discovery first** to find available actions and their goal/result structures.

```bash
# Step 1: Discover available actions
python3 {baseDir}/scripts/ros2_cli.py actions list

# Step 2: Find actions by type (optional)
python3 {baseDir}/scripts/ros2_cli.py actions find turtlesim/action/RotateAbsolute
python3 {baseDir}/scripts/ros2_cli.py actions find nav2_msgs/action/NavigateToPose

# Step 3: Get action goal/result structure
python3 {baseDir}/scripts/ros2_cli.py actions details /turtle1/rotate_absolute

# Step 4: Send goal with properly-structured payload
python3 {baseDir}/scripts/ros2_cli.py actions send /turtle1/rotate_absolute \
  '{"theta":1.57}'

# Step 5: Monitor feedback — always echo after sending a goal
python3 {baseDir}/scripts/ros2_cli.py actions echo /turtle1/rotate_absolute --timeout 30
```

**After every `actions send`, immediately run `actions echo` on the same action server** to monitor feedback.

### 6. Change Parameters

**Always use auto-discovery first** to list available parameters for a node.

```bash
# Step 1: Discover nodes
python3 {baseDir}/scripts/ros2_cli.py nodes list

# Step 2: List parameters for a node
python3 {baseDir}/scripts/ros2_cli.py params list /turtlesim

# Step 3: Get current parameter value
python3 {baseDir}/scripts/ros2_cli.py params get /turtlesim:background_r

# Step 4: Set parameter value
python3 {baseDir}/scripts/ros2_cli.py params set /turtlesim:background_r 255

# Step 5: Read back after set — always verify the change took effect
python3 {baseDir}/scripts/ros2_cli.py params get /turtlesim:background_r
```

**After every `params set`, always run `params get` on the same parameter** to confirm the change was accepted.

### 7. Goal-Oriented Commands (publish-until)

For any goal with a sensor-based stop condition — joint angles, temperature limits, proximity, battery level — use `publish-until` with the appropriate monitor topic and condition flag. **Always discover both the command topic and the monitor topic before executing** — never hardcode names.

| User intent | Discover command topic | Discover monitor topic | Condition |
|-------------|----------------------|----------------------|-----------|
| Stop near obstacle | `topics find geometry_msgs/Twist` + `TwistStamped` | `topics find sensor_msgs/LaserScan` → field `ranges.0` | `--below 0.5` |
| Stop at range | same | `topics find sensor_msgs/Range` → field `range` | `--below D` |
| Stop at temperature | — | `topics find sensor_msgs/Temperature` → field `temperature` | `--above T` |
| Stop at battery level | — | `topics find sensor_msgs/BatteryState` → field `percentage` | `--below P` |
| Joint reach angle | `topics find trajectory_msgs/JointTrajectory` or similar | `topics find sensor_msgs/JointState` → field `position.0` | `--equals A` or `--delta D` |
| Multi-joint distance | same | `topics find sensor_msgs/JointState` → fields `position.0 position.1` | `--euclidean --delta D` |

**`--euclidean`** computes `sqrt(Σ(current_i - start_i)²)` across all `--field` paths. Use it for curved or diagonal paths. **Composite field shorthand**: `--field pose.pose.position` auto-expands to `x, y, z`.

```bash
# Example: stop when front range sensor reads < 0.5 m
# Step 1: discover velocity topic
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/msg/Twist
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/msg/TwistStamped

# Step 2: discover laser scan topic
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/LaserScan

# Step 3: execute with discovered names
python3 {baseDir}/scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '<payload>' \
  --monitor <SCAN_TOPIC> --field ranges.0 --below 0.5 --timeout 30
```

### 8. Topic and Service Discovery

**Never guess topic names.** Any time an operation involves a topic, discover the actual topic name from the live graph first.

### Images and Camera

**Always prefer compressed topics** - use much less bandwidth:
```bash
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/CompressedImage
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/Image
```
Use `topics capture-image --topic <discovered>` - never `subscribe` for images.

### Velocity Commands (Twist vs TwistStamped)

Check both types to find the topic:
```bash
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/msg/Twist
python3 {baseDir}/scripts/ros2_cli.py topics find geometry_msgs/msg/TwistStamped
```
Then confirm the exact type of the discovered topic:
```bash
python3 {baseDir}/scripts/ros2_cli.py topics type <discovered_topic>
```

---

## Agent Vocabulary: Natural-Language Trigger Words

Maps user intent phrases to the correct ros2-skill command sequence. When a phrase below appears in a user request, use the mapped command — do not ask which command to run.

### Node execution model

| User intent | Correct approach | Notes |
|---|---|---|
| "run X", "start node X", "launch X as a node" | `run new <package> <executable>` | Standalone process — node runs in its own OS process |
| "load component X into container Y", "load X into component container" | `component load <container> <package> <plugin>` | Intra-process component — shares address space with container |
| "list running containers and components" | `component list` | Shows all containers and their loaded component IDs and names |
| "unload component X", "remove component with ID N" | `component unload <container> <unique_id>` | Removes a component without killing the container |
| "run <plugin> standalone", "standalone container for <plugin>", "run <plugin> without an existing container" | `component standalone <package> <plugin>` | Creates its own container + loads in one step; container persists in tmux, kill with `component kill <session>` |
| "kill standalone", "stop standalone container", "cancel standalone" | `component kill <session>` | Terminates the container's tmux session; get the session name from `component standalone` output or `run list` |

**Key distinction:** `run new` creates a standalone OS process. `component load` inserts a composable node into an already-running container (`rclcpp::ComponentManager`) — lower IPC overhead, same address space. Use `component list` to discover available containers before loading.

---

### Parameter files and YAML config

| User intent | Correct command |
|---|---|
| "load params from file", "apply YAML params", "use config file", "load parameters from YAML" | `params load <node> <yaml_file>` |
| "apply config to node X" | `params load <node> <yaml_file>` |
| "use `--params-file` in launch" | Pass via `launch new <pkg> <file> --params-file <path>` |

**Pre-load validation (Rule 0 — mandatory):** Before loading any YAML file, run `params list <node>` and compare YAML keys against declared parameters. Any YAML key not matching a declared parameter is silently ignored. Verify each intended key is present before loading.

---

### Bag files

| User intent | Correct command |
|---|---|
| "what's in this bag", "bag file info", "how long is the bag", "what topics does the bag have" | `bag info <path>` |

**Note:** `bag info` does not require a live ROS 2 graph — it reads `metadata.yaml` from the bag directory.

---

### Testing

| User intent | Correct command |
|---|---|
| "run tests for package X", "test package X", "check if tests pass" | `colcon test --packages-select <pkg>` *(direct CLI — not in ros2-skill)* |
| "run the test suite", "run all tests" | `colcon test` *(direct CLI)* |
| "run pytest", "run unit tests" | `python3 -m pytest <path>` *(direct CLI)* |
| "show test results", "what tests failed" | `colcon test-result --all` *(direct CLI)* |

**Note:** Testing commands operate on the build system, not the live ROS 2 graph — they are outside the scope of `ros2_cli.py`. Use direct CLI commands. These commands do not require a running robot.

---

### Diagnostics: runtime log level

| User intent | Correct command |
|---|---|
| "enable debug logging for node X", "set log level to debug", "get more verbose output from X" | `services call <SET_LOGGER_LEVEL_SERVICE> '{"logger_name": "", "level": 10}'` |
| "reset log level", "disable debug logging" | `services call <SET_LOGGER_LEVEL_SERVICE> '{"logger_name": "", "level": 20}'` |

**Discovery:** Find the service with `services find rcl_interfaces/srv/SetLoggerLevel`. Level values: `10` = DEBUG, `20` = INFO, `30` = WARN, `40` = ERROR. Use `logger_name: ""` for the root logger, or specify the node's logger name to narrow scope.

---

### Daemon and deployment context

| User intent | Correct command |
|---|---|
| "check daemon status", "is the ROS daemon running" | `daemon status` |
| "start the daemon", "restart daemon" | `daemon start` |
| "stop the daemon" | `daemon stop` |
| "what domain ID is in use", "check ROS_DOMAIN_ID" | Check env: `echo $ROS_DOMAIN_ID` *(direct shell)* |

**Note:** `ROS_DOMAIN_ID` defaults to `0` and is user-configurable. If the graph looks unexpectedly large (too many unrecognised nodes), a domain collision with another system is likely — check with `echo $ROS_DOMAIN_ID` and verify the expected value with the user.

**Setting `ROS_DOMAIN_ID` — important limitation:** `export ROS_DOMAIN_ID=X` in a subprocess does not propagate to the parent shell. The agent cannot persistently change this value for future `ros2_cli.py` calls — each call inherits the environment it was launched with. To apply a different domain ID for a single command, prefix it: `ROS_DOMAIN_ID=42 python3 {baseDir}/scripts/ros2_cli.py topics list`. For a persistent change, the user must set the variable in their shell before launching the agent.

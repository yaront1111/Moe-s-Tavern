# Changelog

All notable changes to ros2-skill will be documented in this file.

## [Unreleased] - 2026-06-04

### Changes

- **`context --include-schemas`:** new opt-in flag; appends `schemas: {type_str: fields_dict}` to the context output for every unique topic message type; uses `_expand_fields` at depth=1; output is unchanged without the flag
- **`topics publish` / `publish-sequence` / `publish-until` — `--max-vel`/`--max-ang` documented:** added to `references/COMMANDS.md` option tables; clamped axes reported in `velocity_clamped`

## [1.0.8] - 2026-05-20 (updated 2026-05-29)

Nav2 navigation, Foxglove Bridge management, robot power lifecycle commands, map lifecycle, and several quality-of-life improvements. **Note:** foxglove, system, and nav2 map/mode/localize commands are implemented and unit-tested but not validated on real hardware.

### New Commands

- `foxglove start [--port PORT]` — launch `foxglove_bridge` in a tmux session; checks for apt install; default port 8765; output: `{started, session, port, pid}`
- `foxglove stop` — kill the `foxglove_bridge` tmux session; noop if not running; output: `{stopped, was_running}`
- `foxglove status` — check if session alive and report port + PID; output: `{running, session, port, pid}`
- `system battery [--topic T] [--threshold N] [--warn N] [--timeout 5]` — one-shot subscribe to any `sensor_msgs/BatteryState` topic; returns `{voltage, percentage, power_supply_status, health}` where health is `ok` / `warning` / `critical` (thresholds: 30% warn, 20% critical)
- `system shutdown [--confirm] [--timeout 10]` — requires `--confirm`; attempts `/shutdown` ROS service first, falls back to `sudo shutdown now`; output includes `method`
- `system reboot [--confirm] [--timeout 10]` — same pattern as shutdown; falls back to `sudo reboot`
- `nav2 go <x> <y> [--yaw DEG] [--frame map] [--timeout 120] [--feedback] [--action NAME]` — send a `NavigateToPose` goal and block until SUCCEEDED / ABORTED / timeout; `--feedback` streams per-step messages; `--yaw` sets goal heading
- `nav2 cancel [--action NAME] [--timeout 10]` — cancel all active `NavigateToPose` goals, then publish three zero-velocity messages; call before every new navigation goal
- `nav2 status [--timeout 5]` — report Nav2 active state, one feedback message (2 s window), and `/collision_monitor_state`; output: `{nav2_available, action_server, active_goal, collision_monitor}`
- `nav2 go-waypoints x1,y1 x2,y2 ... [--yaw DEG] [--frame map] [--timeout 120] [--no-stop-on-failure]` — chain `NavigateToPose` calls through a sequence of waypoints; stops on first failure by default; output includes `total_waypoints`, `completed`, `succeeded`, `failed`, `stopped_early`
- `nav2 initial-pose <x> <y> [--yaw DEG] [--frame map]` — publish `PoseWithCovarianceStamped` to `/initialpose` three times to re-localise AMCL
- `nav2 map list [--maps-dir DIR]` — list slam_toolbox `.yaml` map files; output: `{maps: [{name, path, size_kb}], count, maps_dir}`
- `nav2 map save [--name NAME] [--timeout 30]` — call slam_toolbox `SerializePoseGraph`; name defaults to ISO timestamp; output: `{saved, name, path}`
- `nav2 map load <name> [--timeout 15]` — call `map_server/load_map` with the named map's `.yaml`; output: `{loaded, map_url, result_code}`
- `nav2 map delete <name> [--maps-dir DIR] [--confirm]` — requires `--confirm`; removes `.yaml` + `.pgm`/`.png` files; output: `{deleted, name, files_removed}`
- `nav2 mode get [--timeout 3]` — infer slam mode from slam_toolbox and amcl lifecycle states: `mapping` / `navigation` / `mapfree` / `unknown`
- `nav2 mode set <mapfree|mapping|navigation> [--timeout 30]` — perform lifecycle transitions to activate/deactivate slam_toolbox and amcl; output: `{mode, transitions_performed}`
- `nav2 localize [--service S] [--timeout 5]` — call `std_srvs/srv/Empty` on `/reinitialize_global_localization` to spread AMCL particles globally; output: `{localized, service_called, amcl_running}`
- `params exists /node:param [--timeout 5]` — check whether a parameter exists without fetching its value; `type == 0` (NOT_SET) means absent; output: `{exists, node, param, name}`
- `actions status <action> [--timeout 3]` — subscribe once to `/<action>/_action/status` and return goal list with human-readable status names; output: `{action, goal_statuses: [{goal_id, status, status_name, active}], active_count}`
- `topics classify` — classify all topic names and types into seven semantic roles (`motion`, `sensor`, `camera`, `diagnostics`, `tf`, `battery`, `other`); output includes `by_role` dict and `capabilities` flags (`has_camera`, `has_depth`, `has_laser`, `has_pointcloud`, `has_odom`, `has_imu`, `has_joint_states`, `has_battery`)
- `params get-all-nodes <param_name>` — query every running node for a single parameter name; returns `{param, nodes: {node: value}, count, not_set: []}`
- `services info --verbose` — on Lyrical+, appends `servers` and `clients` QoS detail; degrades gracefully with `verbose_note` on earlier distros
- `topics bw` — extended: zero or more topic names; `--all` monitors every published topic; multi-topic uses `MultiThreadedExecutor`; output: `{topics: {name: {bw, bytes_per_msg, rate, samples}}, no_data: [...], count: N}`
- `params set` — extended: multiple `node:param value` pairs in one call; `--type {bool,int,float,str}` forces coercion; multi-pair output: `{results: [...]}`

### Changes

- **`topics subscribe` / `topics echo` — `--max-bytes N`:** stop duration-mode collection when JSON output reaches N bytes; output adds `bytes_collected` and `capped_bytes`
- **`topics subscribe` / `topics echo` — `--throttle-rate-ms N`:** drop messages within N ms of the previous accepted message; useful for high-rate topics
- **`topics subscribe` / `topics echo` — capped output fields:** adds `capped: bool` and `messages_dropped: int` to duration-mode output
- **`topics capture-image --inline`:** adds `image_base64` and `image_encoding` to output for direct VLM consumption
- **`actions cancel --goal-id UUID`:** cancel a specific goal by UUID; without `--goal-id` the all-goals behaviour is unchanged
- **`actions list` — `has_active_goals`:** `None` when status topic exists but state is indeterminate; `False` when topic absent
- **`interface show --depth N`:** recursively expand composite field types up to N levels; default 0 preserves existing flat behaviour; output adds `"depth": N`
- **Version detection helpers** (`ros2_utils`): `get_ros_distro()`, `_distro_rank()`, `is_at_least(distro)`; alphabetical fallback for future distros
- **Python 3.9 compatibility:** replaced `X | None` union syntax with `Optional[X]` in `ros2_foxglove.py`, `ros2_nav2.py`, `ros2_profile.py`
- **`AGENTS.md` — Step 8 (Battery Pre-flight):** call `system battery` before any multi-step task when a battery topic is present; block on critical (< 20%), warn on low (< 30%)
- **`AGENTS.md` — Rule T10 (Spatial Observation Memory):** tag observed objects with current pose; format: `observed=<object> x=N y=N frame=map ts=T`
- **`AGENTS.md` + `COMMANDS.md`:** Nav2 command group workflow, pre-goal `nav2 cancel` rule, `topics bw` multi-topic syntax, `params set` multi-pair / `--type`, `params get-all-nodes` section, Lyrical launch substitution and env var notes

---

## [1.0.7] - 2026-05-12

Robot profile system, log introspection, and several quality-of-life improvements.

### New Commands

- `context` — compact session-start snapshot: topics (capped at 50), services, actions, and nodes in one call
- `profile scan [--workspace PATH] [--name NAME] [--allow-live] [--robot-type TYPE]` — static-first workspace scan; walks `src/`, queries ament index, parses launch / URDF / YAML; writes `.profiles/<robot>_profile.json`
- `profile show [--section <launch-filename>]` — load saved profile; returns `summary` + `annotations` + section list; `--section` for progressive disclosure
- `profile rescan [--launch-file F]` — full rescan or fast partial rescan for a single launch file
- `profile list` — list all saved profiles
- `profile annotate "note"` — append a free-text note; persists across rescans; shown at every `profile show`
- `launch new --param key:=value` / `--config-path PATH` / `--preset NAME` — inline params, YAML config, and preset loading; duplicate session detection included
- `pkg create <name>` — scaffold a new ROS 2 package (`--build-type`, `--dependencies`, `--node-name`, etc.)
- `logs list-runs` / `logs query` / `logs tail` / `logs node-summary` — log introspection without a live graph; reads `~/.ros/log/`; relative (`-30s`, `-5m`) and absolute time filters
- `topics echo-once <topic>` — subscribe, return first message, exit
- `topics depth-point --topic T --u U --v V` — depth at pixel (u, v); 16UC1 and 32FC1; returns `{depth_m, invalid, encoding}`

### Changes

- **Robot profile — sensor mounts:** `summary.sensor_mounts` lists sensors and actuators from URDF (`camera`, `depth_camera`, `lidar`, `imu`, `sonar`, `gps`, `gripper`) with `{joint, link, sensor_type, xyz, rpy}`; visual sensors carry `image_rotation_deg`
- **Robot profile — type detection:** token-level package matching; `robot_type_evidence` and `robot_features` added to `summary`; `--robot-type TYPE` override on `scan` and `rescan`
- **Robot profile — drive / kinematics:** `drive_type`, `kinematics`, `cmd_vel_topic`, `odom_frame_ids`, `hardware_interfaces`, `lidar_config`, `camera_configs`, `localization_config`, `nav2_config`, `teleop_config`, `estop_config`, `tf_frames`, `launch_configurations`, `active_controllers`
- **Robot profile — extended config:** `controller_plugins`, `mock_hardware_available`, `maps`, `sensor_filter_pipeline`, `imu_config`, `package_dependencies`
- **Robot profile — workspace scoping:** `--packages <pattern>` separates `primary_packages` from `dependency_packages`; `pkg_filter` stored in profile for rescan reuse
- **Robot profile — null elimination:** absent fields are omitted entirely (never `null`, `[]`, or `{}`); a missing key means "not detected"
- **Robot profile — unified launch args:** `detail.<file>.launch_args` merged to `{arg: {default, choices?, description?}}`; AST defaults + runtime-resolved overrides; `launch_arg_choices` key removed
- **`topics capture-image`:** profile-aware; applies `cv2.rotate()` from `sensor_mounts.image_rotation_deg`; output adds `profile_applied` and `image_rotated_deg`; `--no-profile` to bypass
- **`topics list` / `ls`:** default cap 50; `--limit N` added; output adds `truncated` and `total` when capped
- **`params get`:** multi-key — `params get /node key1 key2` returns `{parameters: {key: {value, exists}}, count}`
- **`topics publish` / `publish-sequence` / `publish-until`:** `--max-vel N` / `--max-ang N` clamp linear and angular velocity before send; clamped axes in `velocity_clamped`
- **`topics publish-sequence`:** auto-hold on exit — 3 zero-velocity messages on completion, exception, or interrupt
- **Path A guards:** `check_topics_find_path_a` / `check_services_find_path_a` rewritten as data-driven tables; velocity, odometry, and e-stop types extracted dynamically from profile
- Shell injection hardening: `shlex.quote()` on all user-controlled inputs
- `RULES.md` split into five domain files (`RULES-CORE`, `RULES-PREFLIGHT`, `RULES-MOTION`, `RULES-DIAGNOSTICS`, `RULES-REFERENCE`); `RULES.md` is now a navigation index
- Session Start Checklist extended to 7 steps: Step 6 = `context`, Step 7 = `profile show`
- Unhandled exceptions serialised as `{"error": "…", "type": "…"}` instead of raw tracebacks

---

## [1.0.6] - 2026-03-24

Completed the component command group, hardened agent self-recovery behaviour, and added vocabulary and rules for bags, camera calibration, log directories, and Nav2 goal preemption.

### New Commands

- `component list` / `component ls` — list all running component containers and their loaded components
- `component load <container> <package> <plugin>` — load a composable node into an existing container
- `component unload <container> <unique_id>` — unload a composable node by its unique ID
- `component standalone <package> <plugin>` — start a fresh container in a tmux session and load the plugin in one step; container named `standalone_<plugin_class>` (e.g. `demo_nodes_cpp::Talker` → `/standalone_talker`)
- `component kill <session>` — kill a standalone container session (`comp_*` prefix); companion to `run kill` and `launch kill`

### Changes

- Fixed `component standalone` container path for `component_container_isolated` (`/{name}/_container`); timeout error now distinguishes alive-but-slow, service at alternate path, and crashed; orphaned sessions cleaned up automatically on failure
- Fixed `--log-level` argument type to prevent `PyLong_Check` assertion failure
- Agent rules: act on CLI `hint` key immediately; autonomous tmux session error recovery table; banned "you may need to…"; background-launch narration banned; session kill routing by prefix
- Bag vocabulary added (`record a bag`, `play back bag`, `bag info`); camera calibration vocabulary row added; log directory resolution added to session-start rules; Nav2 in-flight goal preemption added as companion to Rule 9
- Documentation: `run kill` corrected to `component kill` everywhere; COMMANDS.md, EXAMPLES.md, CLI.md, README.md updated

---

## [1.0.5] - 2026-03-21

Comprehensive self-reliance review. Added introspection commands, hardened safety and motion rules, introduced AGENTS.md, and made the deceleration zone dynamic.

### New Commands

- `bag info <bag_path>` — bag metadata (duration, message counts, per-topic stats); no live graph required
- `component types` — list registered rclcpp composable node types; no live graph required
- `daemon status` / `daemon start` / `daemon stop` — ROS 2 daemon management
- `params find <pattern> [--node N]` — search all live nodes for params matching a substring
- `tf tree` — ASCII visualization of the full TF frame hierarchy
- `tf validate` — DFS cycle detection and multiple-parent checks across the TF graph
- `topics qos-check <topic>` — compare publisher/subscriber QoS profiles; suggests fix flags
- `launch list <keyword>` — find launch files across installed packages by keyword (no keyword = existing session list behaviour)
- `pkg list` / `pkg ls` — list all installed packages; no live graph required
- `pkg prefix <package>` — resolve the install prefix for a package
- `pkg executables <package>` — list executable files provided by a package
- `pkg xml <package>` — output the `package.xml` manifest for a package

### Changes

- `publish-until` deceleration zone auto-computed from kinematics; proximity sensor scan before long motions; velocity-limit scan extended to four sources; QoS auto-matching in `ConditionMonitor`
- Rules: `estop` is a hard preemption; QoS + monitor field pre-flight mandatory; motion ceilings; `publish-until` > 30 s segmented; simulated clock re-verified before every timed command; TF staleness + cycle detection pre-flight; node crash monitoring for commands > 10 s
- Fixes: `scale_twist_velocity` Twist/TwistStamped branching; `cmd_actions_details` None guard; `cmd_version` reports `rclpy_available`; unique per-topic node names
- `AGENTS.md` added — condensed operational guide covering session-start, core rules, movement, and safety

---

## [1.0.4] - 2026-03-14

Added launch, run, and tf commands. Hardened movement safety rules and `--rotate` rotation monitoring.

### Launch Commands

- `launch new <package> <launch_file> [args...]` — run a ROS 2 launch file in a tmux session
- `launch list` — list running launch sessions
- `launch kill <session>` — kill a running launch session
- `launch restart <session>` — restart a launch session
- `launch foxglove [port]` — launch foxglove_bridge (default port: 8765)

### Run Commands

- `run new <package> <executable> [args...]` — run a ROS 2 executable in a tmux session
- `run new --presets <preset>` — apply preset parameters before running
- `run new --params "key:=value"` — set inline parameters
- `run new --config-path PATH` — path to config directory (auto-discovers yaml files)
- `run list` — list running run sessions
- `run kill <session>` — kill a running run session
- `run restart <session>` — restart a run session

### TF2 Commands

- `tf list` — list all coordinate frames
- `tf lookup` / `tf get <source> <target>` — query transform between frames
- `tf echo <source> <target> [--once] [--count N]` — echo transforms
- `tf monitor <frame>` — monitor transform updates for a frame
- `tf static` — publish a static transform (named or positional form)
- `tf euler-from-quaternion` / `tf e2q` / `tf quat2euler` — quaternion → Euler (radians)
- `tf quaternion-from-euler` / `tf q2e` / `tf euler2quat` — Euler → quaternion (radians)
- `tf euler-from-quaternion-deg` / `tf e2qdeg` — quaternion → Euler (degrees)
- `tf quaternion-from-euler-deg` / `tf q2edeg` — Euler → quaternion (degrees)
- `tf transform-point` / `tf tp` / `tf point` — transform a point between frames
- `tf transform-vector` / `tf tv` / `tf vector` — transform a vector between frames

### Skill

- Movement: velocity limit discovery now scans **every running node** (not just controller nodes) — `params list` on all nodes, filter by `max`/`limit`/`vel`/`speed`/`accel`, retrieve each candidate, apply minimum ceiling; conservative defaults 0.2 m/s / 0.75 rad/s if nothing found
- Movement: `--rotate` fixed for negative angles (CW), angles > 180°, and multi-turn rotations; sign of `--rotate` and `angular.z` must always match
- Movement: Case A distance now uses `--euclidean --field pose.pose.position` (frame-independent) instead of a single axis field
- Movement: pre-motion check — read odom twist before publishing; `estop` if robot is already moving
- Movement: odometry rate check before closed-loop; fall back to open-loop if rate < 5 Hz
- Rule 0: mandatory full-graph parameter introspection before every movement command
- Rule 0.1: mandatory session-start checks — `doctor`, simulated time, lifecycle node states
- Rule 0.5: never guess commands or flags; verify in COMMANDS.md then `--help` before use

---

## [1.0.3] - 2026-03-09

Added parameter preset commands, diagnostics monitoring, battery monitoring, and global timeout/retry configuration.

### Global Options

- `--timeout SECONDS` — override the per-command timeout for every ROS 2 call in the session; accepted before any subcommand (e.g. `--timeout 10 params get /node param`)
- `--retries N` — total number of attempts before giving up (default: `1`, i.e. no retry); applies to `wait_for_service`, `wait_for_server`, and async call spin loops across all command handlers
- `_apply_global_overrides(args)` propagates the global values onto per-command `timeout`/`retries` attributes after argparse; commands that have no `--timeout` arg (e.g. `topics list`) are explicitly guarded with `hasattr`

### Internal — Retry hardening

- `future.cancel()` is now called before every retry `continue` in all spin loops (18 sites across `ros2_action`, `ros2_control`, `ros2_lifecycle`, `ros2_param`, `ros2_service`) — prevents stale futures from a timed-out attempt delivering results to the next attempt
- `cmd_actions_send`: moved `wait_for_server` inside the retry loop so server unavailability is actually retried
- `cmd_actions_cancel`: added full retry loop (was missing entirely)

### Topics — Diagnostics & Battery

- `topics diag-list` — list all topics publishing `DiagnosticArray` messages, discovered by **type** (not by name); works with `/diagnostics`, `<node>/diagnostics`, `<namespace>/diagnostics`, or any other convention
- `topics diag` — subscribe to all discovered diagnostic topics simultaneously (or a specific `--topic`); returns parsed status with `level_name` (OK/WARN/ERROR/STALE), `name`, `message`, `hardware_id`, and key-value `values`; supports `--duration` + `--max-messages` for multi-message collection and `--timeout` for one-shot mode
- `topics battery-list` — list all topics publishing `BatteryState` messages, discovered by type
- `topics battery` — subscribe to battery topics; returns parsed state including percentage, voltage, current, charge, and cell details (handles NaN and numeric-to-label conversion for status/health/tech)

### Skill

- Auto-discovery: movement velocity limits, diagnostics, and battery topics are now auto-discovered by scanning the live graph's message types and parameters.

### Parameters — Presets

- `params preset-save <node> <preset>` — save the current live parameters of a node to `.presets/{preset}.json`; uses `ListParameters` + `GetParameters` and writes a plain `{param_name: value}` JSON file
- `params preset-load <node> <preset>` — restore a named preset onto a node via `SetParameters`; reports per-parameter success and failure reasons
- `params preset-list` — list all saved presets from `.presets/`; no arguments; no running ROS 2 graph required
- `params preset-delete <preset>` — remove a saved preset file by name only (no node arg needed); no running ROS 2 graph required
- Presets stored flat as `.presets/{preset}.json` beside the skill directory; use descriptive names like `turtlesim_indoor` to identify node and configuration

### Internal

- Refactored `cmd_params_dump`: extracted `_dump_params(node_name, timeout) -> dict | None` helper so preset-save can reuse the dump logic without going through `output()`
- `resolve_output_path()` now writes to `.artifacts/` (hidden) instead of `artifacts/`

---

## [1.0.2] - 2026-03-07

Added `doctor`, `wtf`, `multicast`, and `interface` commands for ROS 2 system health checking, UDP multicast diagnostics, and interface type discovery.

### Interface

- `interface list` — list all installed interface types across all packages; output groups by `messages`, `services`, `actions` with a `total` count; reads from the ament resource index, no running ROS 2 graph required
- `interface show <type>` — show the field structure of any message, service, or action type; accepts canonical formats (`pkg/msg/Name`, `pkg/srv/Name`, `pkg/action/Name`) and shorthand (`pkg/Name`); output includes `"kind"` (`message`/`service`/`action`) and the appropriate field dicts (`fields` for messages, `request`/`response` for services, `goal`/`result`/`feedback` for actions)
- `interface proto <type>` — show a default-value prototype of any message, service, or action type; unlike `show` (type strings), `proto` instantiates the type so output contains actual default values — useful as a copy-paste template for publish payloads; nested messages are recursively expanded
- `interface packages` — list all packages that define at least one interface type
- `interface package <pkg>` — list all interface types (messages, services, actions) for a specific package

### Doctor / Wtf

- `doctor` — run ROS 2 system health checks via `ros2doctor` entry-point checkers; outputs JSON summary with `passed/failed/warned` counts and per-checker `status` (`PASS`/`WARN`/`FAIL`)
- `doctor hello` — check cross-host connectivity: publishes a `std_msgs/String` on a configurable topic (default `/canyouhearme`) and sends UDP multicast packets to `225.0.0.1:49150`; reports which remote hosts replied via ROS and multicast
- `wtf` — exact alias for `doctor`; same flags (`--report`, `--report-failed`, `--exclude-packages`, `--include-warnings`) and same `hello` subcommand
- Flags: `--report` / `-r` (all reports), `--report-failed` / `-rf` (failed-checker reports only), `--exclude-packages` / `-ep` (skip package checks), `--include-warnings` / `-iw` (treat warnings as failures)

### Multicast

- `multicast send [--group GROUP] [--port PORT]` — send one UDP multicast datagram to the specified group and port (defaults: `225.0.0.1:49150`); returns JSON with `sent` details
- `multicast receive [--group GROUP] [--port PORT] [--timeout SEC]` — listen for UDP multicast packets and return all received within the timeout window (default: 5 s); returns JSON with `received` list, `total`, `group`, `port`, and `timeout`
- Flags: `--group` / `-g` (multicast group, default: `225.0.0.1`), `--port` / `-p` (UDP port, default: `49150`), `--timeout` / `-t` (receive only, default: `5.0`)

---

## [1.0.1] - 2026-03-07

Refactored the CLI into separate domain modules and added two new command domains: lifecycle (managed node introspection and control) and control (ros2_control controller manager operations).

### Architecture

- Decomposed `ros2_cli.py` into domain modules (`ros2_topic.py`, `ros2_node.py`, `ros2_param.py`, `ros2_service.py`, `ros2_action.py`, `ros2_lifecycle.py`, `ros2_control.py`) with shared utilities in `ros2_utils.py`; `ros2_cli.py` now acts as the dispatcher and argument parser only

### Topics

- `topics capture-image` — capture a single frame from a ROS 2 image topic (compressed or raw), save to `.artifacts/`; optional Discord send via `--channel-id` and `--config`

### Lifecycle

- `lifecycle nodes` — list all managed (lifecycle) nodes by scanning for `/get_state` services
- `lifecycle list` / `ls` — list available states and transitions for one or all managed nodes
- `lifecycle get` — get the current lifecycle state of a managed node
- `lifecycle set` — trigger a lifecycle state transition by label (e.g. `configure`, `activate`) or numeric ID

### Control

- `control list-controller-types` / `lct` — list controller plugin types available in the pluginlib registry
- `control list-controllers` / `lc` — list loaded controllers, their type, and current state
- `control list-hardware-components` / `lhc` — list hardware components (actuator, sensor, system) and their lifecycle state
- `control list-hardware-interfaces` / `lhi` — list all command and state interfaces
- `control load-controller` / `load` — load a controller plugin by name
- `control unload-controller` / `unload` — unload a stopped controller
- `control reload-controller-libraries` / `rcl` — reload controller plugin libraries; `--force-kill` stops running controllers first
- `control set-controller-state` / `scs` — activate or deactivate a single controller via `SwitchController`
- `control set-hardware-component-state` / `shcs` — drive a hardware component through its lifecycle (`unconfigured`, `inactive`, `active`, `finalized`)
- `control switch-controllers` / `sc` — atomically activate and/or deactivate multiple controllers in a single `SwitchController` call; `--strictness STRICT|BEST_EFFORT`
- `control view-controller-chains` / `vcc` — generate a Graphviz DOT diagram of loaded chained controllers, render to PDF in `.artifacts/`, optionally send to Discord
- `control configure-controller` / `cc` — explicitly configure a loaded controller (`unconfigured → inactive`) via the `ConfigureController` service; surfaces `on_configure()` errors that `SwitchController`'s silent auto-configure hides

### Fixes

- `control set-hardware-component-state` (`shcs`) — fixed `AttributeError`: response field is `state` (not `actual_state`) in all distros; `actual_state` key still present in JSON output
- `lifecycle set` — four-level fuzzy matching so any short form resolves to a full transition label: (1) exact, (2) suffix (`shutdown` → `unconfigured_shutdown`; `success` → `on_configure_success`), (3) prefix (`unconfigured` → `unconfigured_shutdown`; `on_configure` → `on_configure_success`), (4) substring (`configure` → `on_configure_success`); all four levels are generic for every transition, not only shutdown

### Utilities

- `resolve_output_path()` added to `ros2_utils.py` — shared helper for `--output` arguments; plain filename → `.artifacts/` (created if absent), explicit path → used as-is

---

## [1.0.0] - 2026-03-01

Initial release of ros2-skill — an adaptation of [ros-skill](https://github.com/lpigeon/ros-skill) redesigned for direct local ROS 2 communication via rclpy instead of rosbridge.

### Topics

- `topics list` / `ls` — list all active topics
- `topics type` — get the message type of a topic
- `topics details` / `info` — publishers, subscribers, and QoS for a topic
- `topics message` / `message-structure` / `message-struct` — introspect message field structure
- `topics subscribe` / `echo` / `sub` — collect messages; `--duration` + `--max-messages` for batch collection
- `topics publish` / `pub` / `publish-continuous` — single-shot or timed publish at `--rate` Hz
- `topics publish-sequence` / `pub-seq` — publish a sequence of messages with per-step durations
- `topics publish-until` — publish while monitoring a separate topic; stops when a condition is met (`--delta`, `--above`, `--below`, `--equals`); `--euclidean` for N-dimensional distance across multiple fields
- `topics hz` — measure publish rate (rate, min/max/std_dev of inter-message intervals)
- `topics bw` — measure topic bandwidth (bytes/s, bytes per message)
- `topics delay` — measure end-to-end latency via `header.stamp`
- `topics find` — find all topics publishing a given message type

### Nodes

- `nodes list` / `ls` — list all active nodes
- `nodes details` / `info` — publishers, subscribers, services, action servers, and action clients for a node

### Services

- `services list` / `ls` — list all services
- `services details` / `info` — request and response field structure for a service
- `services call` — call a service with a JSON request
- `services find` — find all services of a given type
- `services echo` — echo service request/response event pairs (requires introspection enabled on the node)

### Parameters

- `params list` / `ls` — list all parameters on a node
- `params get` — get a parameter value
- `params set` — set a parameter value
- `params describe` — describe a parameter (type, constraints, read-only flag)
- `params dump` — bulk-export all parameters for a node as JSON
- `params load` — bulk-set parameters from a JSON string or file
- `params delete` — delete one or more parameters

### Actions

- `actions list` / `ls` — list all action servers
- `actions details` / `info` — goal, result, and feedback structure for an action server
- `actions type` — get the action type of an action server
- `actions send` / `send-goal` — send a goal; `--feedback` streams feedback messages in the output
- `actions find` — find all action servers of a given action type
- `actions echo` — echo live feedback and status messages from an action server
- `actions cancel` — cancel all in-flight goals on an action server

### Utilities

- `version` — detect ROS 2 distro and domain ID
- `estop` — emergency stop; auto-detects velocity topic and publishes zero velocity

---

For the original ros-skill (ROS 1 + ROS 2 via rosbridge), see: [ros-skill](https://github.com/lpigeon/ros-skill)

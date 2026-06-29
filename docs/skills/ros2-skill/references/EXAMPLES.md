# ROS 2 Skill — Examples

Practical, copy-ready examples for every command group. All commands output JSON. Replace placeholder names (shown in `<ANGLE_BRACKETS>`) with values **resolved from the profile (Path A) or, only if the profile is absent or missing the field, discovered from the live graph (Path B)** — never hardcode topic, node, service, action, or frame names.

---

## 1. Graph Exploration — Topics, Nodes, Services, Actions

**Path B (no profile) workflow — run these to map an unknown live system. In Path A (profile loaded), these commands are diagnostic-only; do NOT run them to resolve names the profile already provides (Rule 14).**

```bash
# Detect ROS 2 version, distro, and domain ID
python3 scripts/ros2_cli.py version

# List all active topics with types
python3 scripts/ros2_cli.py topics list

# List all active nodes
python3 scripts/ros2_cli.py nodes list

# List all services with types
python3 scripts/ros2_cli.py services list

# List all action servers
python3 scripts/ros2_cli.py actions list

# Get details for a specific node (publishers, subscribers, services, actions)
python3 scripts/ros2_cli.py nodes details <NODE_NAME>

# Get details for a specific topic (type, publishers, subscribers)
python3 scripts/ros2_cli.py topics details <TOPIC_NAME>

# Find topics by message type
python3 scripts/ros2_cli.py topics find geometry_msgs/msg/Twist
python3 scripts/ros2_cli.py topics find geometry_msgs/msg/TwistStamped
python3 scripts/ros2_cli.py topics find nav_msgs/msg/Odometry
python3 scripts/ros2_cli.py topics find sensor_msgs/msg/LaserScan
python3 scripts/ros2_cli.py topics find sensor_msgs/msg/CompressedImage
python3 scripts/ros2_cli.py topics find sensor_msgs/msg/Image

# Get a topic's message type
python3 scripts/ros2_cli.py topics type <TOPIC_NAME>

# Find services by type
python3 scripts/ros2_cli.py services find std_srvs/srv/Empty
python3 scripts/ros2_cli.py services find std_srvs/srv/SetBool

# Get a service's type
python3 scripts/ros2_cli.py services type <SERVICE_NAME>

# Find actions by type
python3 scripts/ros2_cli.py actions find turtlesim/action/RotateAbsolute
python3 scripts/ros2_cli.py actions find nav2_msgs/action/NavigateToPose
```

---

## 2. Interface Discovery

**No live ROS 2 graph required** — reads from the ament resource index.

```bash
# List all installed interface types (messages, services, actions)
python3 scripts/ros2_cli.py interface list

# Show field structure of a message, service, or action type
python3 scripts/ros2_cli.py interface show geometry_msgs/msg/Twist
python3 scripts/ros2_cli.py interface show std_srvs/srv/SetBool
python3 scripts/ros2_cli.py interface show nav2_msgs/action/NavigateToPose

# Get a default-value prototype (use as payload template)
python3 scripts/ros2_cli.py interface proto geometry_msgs/msg/Twist
python3 scripts/ros2_cli.py interface proto sensor_msgs/msg/JointState
python3 scripts/ros2_cli.py interface proto std_srvs/srv/SetBool

# List all packages that define interfaces
python3 scripts/ros2_cli.py interface packages

# List all interfaces defined by a specific package
python3 scripts/ros2_cli.py interface package geometry_msgs
python3 scripts/ros2_cli.py interface package std_msgs
```

---

## 3. Topic Monitoring & Data Capture

```bash
# Subscribe and return first message
python3 scripts/ros2_cli.py topics subscribe <ODOM_TOPIC>
python3 scripts/ros2_cli.py topics echo <ODOM_TOPIC>

# Collect messages for a duration
python3 scripts/ros2_cli.py topics subscribe <ODOM_TOPIC> --duration 5
python3 scripts/ros2_cli.py topics subscribe <SCAN_TOPIC> --duration 10 --max-messages 50

# Measure publish rate
python3 scripts/ros2_cli.py topics hz <ODOM_TOPIC>
python3 scripts/ros2_cli.py topics hz <ODOM_TOPIC> --window 20 --timeout 15

# Measure bandwidth
python3 scripts/ros2_cli.py topics bw <CAMERA_TOPIC>
python3 scripts/ros2_cli.py topics bw <SCAN_TOPIC> --window 20

# Measure end-to-end latency (requires header.stamp)
python3 scripts/ros2_cli.py topics delay <ODOM_TOPIC>
python3 scripts/ros2_cli.py topics delay <CAMERA_TOPIC> --window 20

# Check QoS compatibility — run before publish-until if subscribe times out unexpectedly
python3 scripts/ros2_cli.py topics qos-check <ODOM_TOPIC>
python3 scripts/ros2_cli.py topics qos-check <CMD_VEL_TOPIC>

# Get message structure for a type
python3 scripts/ros2_cli.py topics message geometry_msgs/msg/Twist
python3 scripts/ros2_cli.py topics message nav_msgs/msg/Odometry

# Capture an image from a camera topic (saved to .artifacts/)
python3 scripts/ros2_cli.py topics capture-image \
  --topic <CAMERA_TOPIC> \
  --output photo.jpg

# Capture with explicit type
python3 scripts/ros2_cli.py topics capture-image \
  --topic <CAMERA_TOPIC> \
  --output photo.jpg \
  --type compressed
```

If multiple camera topics are found, prefer the one matching the user's context (front/rear, color/depth, compressed/raw).

---

## 4. Topic Publishing

```bash
# Single-shot publish
python3 scripts/ros2_cli.py topics publish <TOPIC> '{"data": true}'

# Publish for a duration (preferred for velocity commands)
python3 scripts/ros2_cli.py topics publish <CMD_VEL_TOPIC> \
  '{"linear":{"x":0.3,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' --duration 3

# Publish using TwistStamped (if topics type returns TwistStamped)
python3 scripts/ros2_cli.py topics publish <CMD_VEL_TOPIC> \
  '{"header":{"stamp":{"sec":0},"frame_id":""},"twist":{"linear":{"x":0.3,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}}' \
  --duration 3

# Stop the robot (publish zero velocity)
python3 scripts/ros2_cli.py topics publish <CMD_VEL_TOPIC> \
  '{"linear":{"x":0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}'
```

---

## 5. Robot Motion (Closed-Loop)

**Always resolve topic names before moving. Never hardcode `/cmd_vel` or `/odom`.**

```bash
# Step 1: Resolve velocity topic
# Profile fast-path — VEL_TOPIC = summary.cmd_vel_topic, VEL_TYPE = summary.velocity_topics[].type
# Fallback (profile absent or field missing):
python3 scripts/ros2_cli.py topics find geometry_msgs/msg/Twist
python3 scripts/ros2_cli.py topics find geometry_msgs/msg/TwistStamped
# → confirm exact type:
python3 scripts/ros2_cli.py topics type <VEL_TOPIC>

# Step 2: Resolve odometry topic and verify it is live
# Profile fast-path — ODOM_TOPIC = first value in summary.localization_config.fused_sources
# Fallback (profile absent or field missing):
python3 scripts/ros2_cli.py topics find nav_msgs/msg/Odometry
python3 scripts/ros2_cli.py topics hz <ODOM_TOPIC>
```

### Emergency stop
```bash
python3 scripts/ros2_cli.py estop
python3 scripts/ros2_cli.py estop --topic <CMD_VEL_TOPIC>
```

### Drive forward 1 m (closed-loop)
```bash
python3 scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '{"linear":{"x":0.2,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' \
  --monitor <ODOM_TOPIC> --field pose.pose.position.x --delta 1.0 --timeout 30
```

### Drive 2 m along a curved path (Euclidean distance in XY)
```bash
python3 scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '{"linear":{"x":0.2,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0.2}}' \
  --monitor <ODOM_TOPIC> \
  --field pose.pose.position.x pose.pose.position.y \
  --euclidean --delta 2.0 --timeout 60
```

### Drive with auto-computed deceleration zone (smooth stop)
```bash
python3 scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '{"linear":{"x":0.4,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' \
  --monitor <ODOM_TOPIC> --field pose.pose.position.x --delta 5.0 --timeout 60
# Deceleration zone is auto-computed from velocity and node params.
# To override: add --slow-last 0.5 --slow-factor 0.3
```

### Rotate 90° CCW / left (positive --rotate, positive angular.z)
```bash
python3 scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '{"linear":{"x":0},"angular":{"z":0.5}}' \
  --monitor <ODOM_TOPIC> --rotate 90 --degrees --timeout 30
```

### Rotate 90° CW / right (negative --rotate, negative angular.z)
```bash
python3 scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '{"linear":{"x":0},"angular":{"z":-0.5}}' \
  --monitor <ODOM_TOPIC> --rotate -90 --degrees --timeout 30
```

### Drive until a LiDAR range drops below 0.5 m
```bash
python3 scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '{"linear":{"x":0.2,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}' \
  --monitor <SCAN_TOPIC> --field ranges.0 --below 0.5 --timeout 60
```

### Open-loop fallback (no odometry available)
```bash
# Move forward for 3 seconds, then stop — no distance guarantee
python3 scripts/ros2_cli.py topics publish-sequence <VEL_TOPIC> \
  '[{"linear":{"x":0.3,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}},{"linear":{"x":0,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}]' \
  '[3.0, 0.5]'
```

---

## 6. Services

```bash
# Discover available services and their request structure before calling
python3 scripts/ros2_cli.py services list
python3 scripts/ros2_cli.py services details <SERVICE_NAME>

# Basic service call
python3 scripts/ros2_cli.py services call <SERVICE_NAME> '{}'

# Call with payload
python3 scripts/ros2_cli.py services call <SERVICE_NAME> '{"data": true}'

# Call with explicit type override (when auto-detect fails)
python3 scripts/ros2_cli.py services call <SERVICE_NAME> \
  '{"data": true}' --service-type std_srvs/srv/SetBool

# Longer timeout for slow services
python3 scripts/ros2_cli.py --timeout 30 --retries 3 services call <SERVICE_NAME> '{}'

# Listen to service events (requires introspection enabled on server/client)
python3 scripts/ros2_cli.py services echo <SERVICE_NAME> --timeout 30
python3 scripts/ros2_cli.py services echo <SERVICE_NAME> --max-messages 2
```

---

## 7. Actions

**Always discover action name and goal structure before sending a goal.**

```bash
# List all action servers
python3 scripts/ros2_cli.py actions list

# Get goal/result/feedback structure
python3 scripts/ros2_cli.py actions details <ACTION_NAME>

# Get action type
python3 scripts/ros2_cli.py actions type <ACTION_NAME>

# Send a goal and wait for result
python3 scripts/ros2_cli.py actions send <ACTION_NAME> '<json_goal>'

# Send a goal and collect feedback during execution
python3 scripts/ros2_cli.py actions send <ACTION_NAME> '<json_goal>' --feedback

# Longer timeout for long-running actions
python3 scripts/ros2_cli.py actions send <ACTION_NAME> '<json_goal>' \
  --feedback --timeout 120

# Cancel all in-flight goals on an action server
python3 scripts/ros2_cli.py actions cancel <ACTION_NAME>

# Echo live feedback from an action server (while goal is running)
python3 scripts/ros2_cli.py actions echo <ACTION_NAME>
python3 scripts/ros2_cli.py actions echo <ACTION_NAME> --duration 10
python3 scripts/ros2_cli.py actions echo <ACTION_NAME> --duration 30 --max-messages 20
```

---

## 8. Parameters

**Always discover the node name and parameter names before reading or writing.**

```bash
# List all parameters for a node
python3 scripts/ros2_cli.py params list <NODE_NAME>

# Get a single parameter value
python3 scripts/ros2_cli.py params get <NODE_NAME>:<PARAM_NAME>
python3 scripts/ros2_cli.py params get <NODE_NAME> <PARAM_NAME>

# Describe a parameter (type, description, constraints, read-only)
python3 scripts/ros2_cli.py params describe <NODE_NAME>:<PARAM_NAME>

# Set a parameter (always describe first to confirm type and read-only status)
python3 scripts/ros2_cli.py params set <NODE_NAME>:<PARAM_NAME> <VALUE>
python3 scripts/ros2_cli.py params set <NODE_NAME> <PARAM_NAME> <VALUE>

# Dump all parameters from a node
python3 scripts/ros2_cli.py params dump <NODE_NAME>

# Bulk-load parameters from a JSON string
python3 scripts/ros2_cli.py params load <NODE_NAME> '{"param_a": 1.5, "param_b": true}'

# Bulk-load parameters from a JSON file
python3 scripts/ros2_cli.py params load <NODE_NAME> /path/to/params.json

# Search all nodes for parameters matching a pattern
python3 scripts/ros2_cli.py params find vel
python3 scripts/ros2_cli.py params find limit --node <NODE_NAME>
python3 scripts/ros2_cli.py params find all

# Delete a parameter (node must allow undeclaring)
python3 scripts/ros2_cli.py params delete <NODE_NAME> <PARAM_NAME>
python3 scripts/ros2_cli.py params delete <NODE_NAME> param_a param_b param_c

# Save current parameters as a named preset
python3 scripts/ros2_cli.py params preset-save <NODE_NAME> my_preset

# Restore a preset onto a node
python3 scripts/ros2_cli.py params preset-load <NODE_NAME> my_preset

# List all saved presets
python3 scripts/ros2_cli.py params preset-list

# Delete a preset
python3 scripts/ros2_cli.py params preset-delete my_preset
```

---

## 9. Lifecycle Management

```bash
# List all managed (lifecycle) nodes in the graph
python3 scripts/ros2_cli.py lifecycle nodes

# List available states and transitions for a node
python3 scripts/ros2_cli.py lifecycle list <NODE_NAME>

# List transitions for all managed nodes
python3 scripts/ros2_cli.py lifecycle list

# Get current state of a node
python3 scripts/ros2_cli.py lifecycle get <NODE_NAME>

# Trigger a state transition by label (preferred)
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> configure
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> activate
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> deactivate
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> cleanup
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> shutdown

# Trigger a transition by numeric ID
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> 1   # configure
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> 3   # activate
python3 scripts/ros2_cli.py lifecycle set <NODE_NAME> 4   # deactivate
```

Standard lifecycle sequence: `configure` → `activate` → (running) → `deactivate` → `cleanup` → `configure` again or `shutdown`.

---

## 10. Hardware & Controllers (ros2_control)

**Always list controllers and verify hardware component state before any controller operation.**

```bash
# List all loaded controllers and their states
python3 scripts/ros2_cli.py control list-controllers

# List available controller plugin types
python3 scripts/ros2_cli.py control list-controller-types

# List hardware components and their lifecycle states
python3 scripts/ros2_cli.py control list-hardware-components
python3 scripts/ros2_cli.py control lhc

# List hardware interfaces (command and state interfaces)
python3 scripts/ros2_cli.py control list-hardware-interfaces
python3 scripts/ros2_cli.py control lhi
```

### Explicit load → configure → activate workflow
```bash
# 1. Load controller plugin (brings it to unconfigured)
python3 scripts/ros2_cli.py control load-controller <CONTROLLER_NAME>

# 2. Configure it (unconfigured → inactive); surfaces on_configure() errors
python3 scripts/ros2_cli.py control configure-controller <CONTROLLER_NAME>

# 3. Activate (inactive → active)
python3 scripts/ros2_cli.py control set-controller-state <CONTROLLER_NAME> active
```

### Atomic controller switch (deactivate one, activate another)
```bash
python3 scripts/ros2_cli.py control switch-controllers \
  --deactivate <ACTIVE_CONTROLLER> \
  --activate <INACTIVE_CONTROLLER> \
  --strictness STRICT
```

### Other controller operations
```bash
# Deactivate or unload a controller
python3 scripts/ros2_cli.py control set-controller-state <CONTROLLER_NAME> inactive
python3 scripts/ros2_cli.py control unload-controller <CONTROLLER_NAME>

# Drive hardware component through lifecycle
python3 scripts/ros2_cli.py control set-hardware-component-state <HW_COMPONENT> active
python3 scripts/ros2_cli.py control set-hardware-component-state <HW_COMPONENT> inactive

# Visualise controller chain as PDF
python3 scripts/ros2_cli.py control view-controller-chains
python3 scripts/ros2_cli.py control view-controller-chains --output my_diagram.pdf
```

---

## 11. Transforms (TF2)

**Always discover frame names — never hardcode `map`, `base_link`, `odom`, or any frame name.**

```bash
# Show the full TF frame hierarchy as an ASCII tree
python3 scripts/ros2_cli.py tf tree
python3 scripts/ros2_cli.py tf tree --duration 3

# Validate TF tree for cycles and multi-parent frames
python3 scripts/ros2_cli.py tf validate

# List all available TF frames
python3 scripts/ros2_cli.py tf list

# Lookup transform between two frames (use names from tf list)
python3 scripts/ros2_cli.py tf lookup <SOURCE_FRAME> <TARGET_FRAME>

# Echo transform repeatedly
python3 scripts/ros2_cli.py tf echo <SOURCE_FRAME> <TARGET_FRAME> --count 10
python3 scripts/ros2_cli.py tf echo <SOURCE_FRAME> <TARGET_FRAME> --once

# Monitor transform updates for a specific frame
python3 scripts/ros2_cli.py tf monitor <FRAME> --count 5

# Publish a static transform (runs in tmux session)
python3 scripts/ros2_cli.py tf static 0 0 0.1 0 0 0 base_link camera_link

# Convert quaternion to Euler angles (radians / degrees)
python3 scripts/ros2_cli.py tf euler-from-quaternion 0 0 0.7071 0.7071
python3 scripts/ros2_cli.py tf euler-from-quaternion-deg 0 0 0.7071 0.7071

# Convert Euler angles to quaternion (radians / degrees)
python3 scripts/ros2_cli.py tf quaternion-from-euler 0 0 1.5708
python3 scripts/ros2_cli.py tf quaternion-from-euler-deg 0 0 90

# Transform a point or vector from source to target frame
python3 scripts/ros2_cli.py tf transform-point <TARGET_FRAME> <SOURCE_FRAME> 1.0 0.0 0.0
python3 scripts/ros2_cli.py tf transform-vector <TARGET_FRAME> <SOURCE_FRAME> 1.0 0.0 0.0
```

---

## 12. Diagnostics & Battery

```bash
# List all diagnostic topics (discovered by type, not name)
python3 scripts/ros2_cli.py topics diag-list

# Read latest diagnostics (one-shot, all discovered diagnostic topics)
python3 scripts/ros2_cli.py topics diag

# Read from a specific diagnostic topic
python3 scripts/ros2_cli.py topics diag --topic <DIAG_TOPIC>

# Collect diagnostics over time
python3 scripts/ros2_cli.py topics diag --duration 10 --max-messages 5

# List all battery topics (discovered by type, not name)
python3 scripts/ros2_cli.py topics battery-list

# Read battery state (one-shot, all discovered battery topics)
python3 scripts/ros2_cli.py topics battery

# Read from a specific battery topic
python3 scripts/ros2_cli.py topics battery --topic <BATTERY_TOPIC>
```

---

## 13. Launch Management

```bash
# List running launch sessions
python3 scripts/ros2_cli.py launch list

# Search for launch files by keyword (no session needed)
python3 scripts/ros2_cli.py launch list robot
python3 scripts/ros2_cli.py launch list nav2
python3 scripts/ros2_cli.py launch list camera

# Launch a package in a tmux session
python3 scripts/ros2_cli.py launch new <PACKAGE> <LAUNCH_FILE>

# Launch with arguments
python3 scripts/ros2_cli.py launch new <PACKAGE> <LAUNCH_FILE> use_sim_time:=false

# Kill a running session
python3 scripts/ros2_cli.py launch kill <SESSION_NAME>

# Restart a session (same command as original launch)
python3 scripts/ros2_cli.py launch restart <SESSION_NAME>

# Launch Foxglove bridge for visualisation
python3 scripts/ros2_cli.py launch foxglove
python3 scripts/ros2_cli.py launch foxglove 9000
```

---

## 14. Run Management

```bash
# List running run sessions
python3 scripts/ros2_cli.py run list

# Run a ROS 2 executable in a tmux session
python3 scripts/ros2_cli.py run new <PACKAGE> <EXECUTABLE>

# Run with arguments
python3 scripts/ros2_cli.py run new <PACKAGE> <EXECUTABLE> --ros-args -p speed:=1.0

# Run with inline parameters
python3 scripts/ros2_cli.py run new <PACKAGE> <EXECUTABLE> --params "speed:=1.0,max_vel:=2.0"

# Run with a saved preset
python3 scripts/ros2_cli.py run new <PACKAGE> <EXECUTABLE> --presets indoor

# Kill a running session
python3 scripts/ros2_cli.py run kill <SESSION_NAME>

# Restart a session (same command as original run)
python3 scripts/ros2_cli.py run restart <SESSION_NAME>
```

---

## 15. Package, Component & Bag Introspection

**No live ROS 2 graph required** for all commands in this section.

```bash
# List all installed ROS 2 packages
python3 scripts/ros2_cli.py pkg list

# Find a package's install prefix
python3 scripts/ros2_cli.py pkg prefix <PACKAGE>

# List all executables in a package
python3 scripts/ros2_cli.py pkg executables <PACKAGE>

# Read a package's manifest (package.xml)
python3 scripts/ros2_cli.py pkg xml <PACKAGE>

# List all registered composable node types
python3 scripts/ros2_cli.py component types
```

### Component containers

```bash
# List all running containers and their loaded components
component list

# Load a composable node into a container
component load /my_container demo_nodes_cpp demo_nodes_cpp::Talker

# Load with overridden node name
component load /my_container demo_nodes_cpp demo_nodes_cpp::Talker --node-name my_talker

# Unload a component by its unique_id (from component list or component load output)
component unload /my_container 1
```

**Standalone** (start container + load in one command):
```bash
python3 scripts/ros2_cli.py component standalone demo_nodes_cpp demo_nodes_cpp::Talker
# → starts /standalone_talker container in tmux, loads Talker, returns session + unique_id
python3 scripts/ros2_cli.py component standalone demo_nodes_cpp demo_nodes_cpp::Talker --container-type component_container_mt
# → same but using the multi-threaded container
python3 scripts/ros2_cli.py component kill comp_demo_nodes_cpp_standalone_talker
# → stop the standalone container when done (use the session name from standalone output)
```

```bash
# Inspect bag metadata: duration, topics, message counts, storage format
python3 scripts/ros2_cli.py bag info /path/to/my_bag
python3 scripts/ros2_cli.py bag info /path/to/my_bag/metadata.yaml
```

---

## 16. System Health & Connectivity

```bash
# Check whether the ROS 2 daemon is running
python3 scripts/ros2_cli.py daemon status

# Start the daemon (idempotent — safe to call when already running)
python3 scripts/ros2_cli.py daemon start

# Stop the daemon
python3 scripts/ros2_cli.py daemon stop

# Run ROS 2 system health checks
python3 scripts/ros2_cli.py doctor

# Include warning details
python3 scripts/ros2_cli.py doctor --include-warnings

# Show report sections for failed checks only
python3 scripts/ros2_cli.py doctor --report-failed

# Check cross-host ROS 2 connectivity (multicast + topic round-trip)
python3 scripts/ros2_cli.py doctor hello
python3 scripts/ros2_cli.py doctor hello --timeout 5

# Send one UDP multicast datagram (network connectivity test)
python3 scripts/ros2_cli.py multicast send

# Listen for UDP multicast packets
python3 scripts/ros2_cli.py multicast receive
python3 scripts/ros2_cli.py multicast receive --timeout 10
```

---

## 17. Discord — Image Delivery

**Always use `discord_tools.py` to send files and images. Never use any other Discord integration.**

```bash
# Capture an image and send to Discord
python3 scripts/ros2_cli.py topics capture-image \
  --topic <CAMERA_TOPIC> \
  --output photo.jpg

python3 scripts/discord_tools.py send-image \
  --path .artifacts/photo.jpg \
  --channel-id <CHANNEL_ID> \
  --config ~/.nanobot/config.json

# Send and delete the file after sending
python3 scripts/discord_tools.py send-image \
  --path .artifacts/photo.jpg \
  --channel-id <CHANNEL_ID> \
  --config ~/.nanobot/config.json \
  --delete

# Send a controller diagram to Discord
python3 scripts/ros2_cli.py control view-controller-chains --output diagram.pdf
python3 scripts/discord_tools.py send-image \
  --path .artifacts/diagram.pdf \
  --channel-id <CHANNEL_ID> \
  --config ~/.nanobot/config.json \
  --delete
```

---

## 18. Global Options

These go **before** the command name and apply to all service/action calls.

```bash
# Extend timeout for slow networks or overloaded systems
python3 scripts/ros2_cli.py --timeout 30 params list <NODE_NAME>

# Retry on unreliable networks
python3 scripts/ros2_cli.py --retries 3 lifecycle get <NODE_NAME>

# Combine: 10 s per attempt, 3 total attempts
python3 scripts/ros2_cli.py --timeout 10 --retries 3 services call <SERVICE_NAME> '{}'
```

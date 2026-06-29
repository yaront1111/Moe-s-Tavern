# ROS 2 Skill: Reference Tables

> **This file is part of a split rule set.** The full rule set spans five files:
> - [RULES-CORE.md](RULES-CORE.md) — general agent conduct, applies to every command
> - [RULES-PREFLIGHT.md](RULES-PREFLIGHT.md) — before every action: introspection, session-start, hardware readiness
> - [RULES-MOTION.md](RULES-MOTION.md) — motion workflow: discover → execute → estop → verify
> - [RULES-DIAGNOSTICS.md](RULES-DIAGNOSTICS.md) — when things go wrong: diagnose, verify, escalate
> - **RULES-REFERENCE.md** ← you are here — lookup tables: intent→command, launch workflow, setup

---

### Rule 26 — Always use `discord_tools.py` to send files and images to Discord

**Never use native API calls, tool calls, or any other mechanism to send files or images to Discord.** The only permitted method is the `discord_tools.py send-image` script provided by ros2-skill.

This applies to every case where an image, photo, or file must be delivered to the user via Discord — including:

- Camera captures ("send me a photo", "take a picture and send it", "capture from the webcam")
- Diagnostic outputs (graphs, PDFs, charts)
- Any artifact saved to `.artifacts/` that the user asks to see

**Mandatory workflow for image delivery:**

1. Capture the image: `topics capture-image --topic <DISCOVERED_TOPIC> --output .artifacts/image.jpg`
   - If a robot profile is loaded and the URDF shows the camera is mounted at a non-upright angle, the image is **automatically rotated** before being saved — no extra step required.
   - The output JSON confirms this: `{"success": true, "path": "...", "profile_applied": true, "image_rotated_deg": 180}`.
   - If the auto-rotation is wrong for a specific capture, re-run with `--no-profile` to bypass it.
2. Send it: `python3 scripts/discord_tools.py send-image --path .artifacts/image.jpg --channel-id <CHANNEL_ID> --config ~/.nanobot/config.json --delete`

The `--delete` flag removes the local file after a successful send. Always include it unless the user explicitly asks to keep the file.

❌ Never make a direct Discord API call to upload a file.
❌ Never use any built-in tool or native platform capability to send a file to Discord.
❌ Never skip `discord_tools.py` even if another method appears available or convenient.

---

## Agent Decision Framework (MANDATORY)

**RULE: NEVER ask the user anything that can be discovered from the ROS 2 graph.**

### Motion Context Cues — Vocabulary and Method Selection

**Any of the following words in a user message is a motion command.** Every motion command triggers the full Rule 3 workflow — no exceptions. Odom availability (discovered in Rule 3 Step 2) determines the execution method, not the user's phrasing.

**Motion trigger words (non-exhaustive — treat similar words the same way):**

| Category | Trigger words |
|---|---|
| General motion | move, go, drive, travel, head, proceed, advance, roll, navigate |
| Forward | forward, ahead, straight, onward, front |
| Backward | back, backward, backwards, reverse, retreat |
| Left | left, leftward |
| Right | right, rightward |
| Rotation / turning | rotate, turn, spin, yaw, pivot, swing |
| Strafing (holonomic) | strafe, slide, sidestep, lateral |

**Method selection — always determined by odom availability, not user phrasing:**

```
Motion command received
  │
  ├─ Check odom (Rule 3 Step 2: topics find nav_msgs/msg/Odometry + topics hz)
  │
  ├─ Odom available (≥ 5 Hz) AND target distance/angle specified
  │     └─ publish-until (closed-loop) — PREFERRED
  │
  ├─ Odom available (≥ 5 Hz) AND no target (open-ended)
  │     └─ publish-sequence with stop payload — odom used for pre/post health checks only
  │
  ├─ Odom unavailable (not found or rate < 5 Hz) AND target specified
  │     └─ publish-sequence with calculated duration (open-loop, last resort)
  │        Notify user: "No odometry. Running open-loop — accuracy not guaranteed."
  │
  └─ Odom unavailable AND no target
        └─ publish-sequence with stop payload
           Notify user: "No odometry available."
```

**Never interpret a motion word as "just publish a Twist message" without going through this decision tree.** The choice of `publish-until` vs. `publish-sequence` is always driven by odom availability.

### Step 1: Understand User Intent

| User says... | Agent interprets as... | Agent must... |
|--------------|----------------------|---------------|
| **— INTROSPECTION: DISCOVERY —** | | |
| "what topics / what's publishing / list topics / show all topics / show me everything on the bus / what data is available" | List all active topics | `topics list` |
| "what nodes / what's running / list nodes / what processes / active nodes / who's running / is X node running / is the robot up" | List all running nodes | `nodes list` |
| "what services / list services / what services are available / what can I call / what service endpoints exist" | List all services | `services list` |
| "what actions / list actions / what can the robot do / what action servers exist / what goals can I send" | List all actions | `actions list` |
| "what controllers / list controllers / controller status / which controller is active / is the velocity controller running / what's loaded in the controller manager" | List ros2_control controllers | `control list-controllers` |
| "what hardware / hardware components / actuators / sensors available / what physical hardware is there / what joints are registered" | List hardware components | `control list-hardware-components` |
| "what hardware interfaces / command interfaces / state interfaces / what can be commanded / what's being read from hardware" | List hardware interfaces | `control list-hardware-interfaces` |
| "what controller types / available controller types / what controllers can I load / what plugins are available" | List loadable controller types | `control list-controller-types` |
| "what lifecycle nodes / managed nodes / list lifecycle / what nodes have lifecycle / which nodes need activating" | List lifecycle-managed nodes | `lifecycle nodes` |
| "what TF frames / list frames / what coordinate frames / show TF tree / what frames are being broadcast / what links exist" | List all TF frames | `tf list` |
| "what parameters / list params / show config / what settings does X have / what does X expose / what can I tune on X" | List parameters on a node | `nodes list` → `params list <node>` |
| "is X running / is X online / is X alive / is node X up / did X start" | Check if a specific node is present | `nodes list` → check if X appears |
| "is topic X live / is X publishing / is X active / is anyone publishing X" | Check if topic has active publisher | `topics details <topic>` (publisher_count > 0) + `topics hz <topic>` |
| "does service X exist / is service X available / is X callable" | Check if service is present | `services list` → check for X |
| "does action X exist / is action server X running" | Check if action server is present | `actions list` → check for X |
| **— INTROSPECTION: DETAILS —** | | |
| "what type is topic X / what message type does X use / what does X carry" | Get topic message type | `topics type <topic>` |
| "show details of topic X / how many subscribers does X have / QoS of X / who's listening to X / who publishes X / publisher count / subscriber count" | Get topic details | `topics details <topic>` |
| "what fields does X message have / show X structure / X message layout / what's in an X message / X definition" | Get message field structure | `topics message <type>` or `interface show <type>` |
| "give me X message template / X payload template / copy-paste template for X / default values for X" | Get default message values | `interface proto <type>` |
| "what does service X do / service X request fields / service X signature / how do I call service X / what does X service take" | Get service request/response | `services details <service>` |
| "what does action X take / action X goal fields / action X signature / how do I send action X / what input does X need" | Get action goal/result/feedback | `actions details <action>` |
| "what does node X do / topics of node X / services of node X / what does X publish / what does X subscribe to / node X interfaces" | Get node details | `nodes details <node>` |
| "controller chain / how controllers connect / view controller chain / controller dependencies / controller pipeline" | View controller chain | `control view-controller-chains` |
| "what's the QoS of X / reliability of X / durability of X / is X transient local / best effort or reliable" | Check QoS profile | `topics details <topic>` (read QoS fields) |
| "what namespace is X in / what's the prefix of X / robot namespace" | Inspect topic/node namespace | `topics list` or `nodes list` → examine returned names |
| "use namespace /robot1 / set namespace / restrict to namespace / all commands under /robot1 / work in robot1 namespace" | Apply namespace context for this task | `topics list` → filter results to names with `/robot1` prefix; use only those fully-qualified names for all topic, service, and action commands in this task. No `--namespace` flag exists — filtering is done by inspecting returned names. |
| "list topics for robot1 / topics in /robot2 namespace / what's publishing under /robot1 / multi-robot topic list / topics per robot" | List topics within a specific robot namespace | `topics list` → filter results by `/robot<N>` prefix; `nodes list` → filter by namespace prefix; report only matching names |
| **— READING / MONITORING: GENERIC —** | | |
| "read / listen to / monitor / subscribe to / show me data from / stream / watch / look at / observe / sample / echo / print / dump / what is X publishing / what's on X" | Subscribe to a topic | `topics find <type>` → `topics subscribe <discovered_topic>` |
| "how fast is X publishing / topic rate / is X active / Hz of X / what's the frequency of X / publish rate of X / messages per second" | Check topic publish rate | `topics hz <topic>` (discover topic first if name not given) |
| "bandwidth of X / how much data is X sending / throughput of X / how many bytes per second / data rate of X" | Check topic bandwidth | `topics bw <topic>` |
| "latency of X / delay on X / how delayed is X / lag on X / transmission delay" | Check topic delay | `topics delay <topic>` |
| "is X healthy / is X working / is X OK / is X updating / is X stale" | Check liveness of a topic | `topics hz <topic>` — if rate ≥ expected → healthy; 0 Hz → stale/dead |
| **— READING / MONITORING: SENSORS —** | | |
| "read the LiDAR / scan data / laser scan / range scan / obstacle data / proximity scan / 2D scan" | Subscribe to LaserScan | Find `sensor_msgs/msg/LaserScan` → subscribe |
| "read point cloud / 3D scan / LiDAR points / 3D LiDAR / velodyne / depth points / PCL data" | Subscribe to PointCloud2 | Find `sensor_msgs/msg/PointCloud2` → subscribe |
| "read odometry / where is the robot / current position / current pose / where am I / robot location / robot coordinates / pose estimate" | Subscribe to Odometry | Find `nav_msgs/msg/Odometry` → subscribe (post-motion: use Rule 8 two-phase protocol) |
| "read camera / take a picture / capture image / take a photo / snap / grab a frame / screenshot / what does the camera see / show me the view / photograph" | Capture image from camera | Find `sensor_msgs/msg/CompressedImage` (preferred) or `sensor_msgs/msg/Image` → `topics capture-image --topic <topic>` (profile auto-rotates if camera is non-upright; check `image_rotated_deg` in output) → send via `discord_tools.py send-image` (Rule 26) |
| "read depth image / depth camera / RGBD / depth frame / depth data" | Subscribe to depth Image | Find `sensor_msgs/msg/Image` with `depth` in topic name → subscribe or capture-image |
| "is camera calibrated / check camera calibration / verify camera_info / camera TF registration / is the camera aligned / camera frame in TF / is camera ready / check camera info" | Verify camera calibration and TF alignment before any camera-dependent task | `topics find sensor_msgs/msg/CameraInfo` → `topics subscribe <CAMERA_INFO_TOPIC> --max-messages 1 --timeout 2` (verify `K` intrinsic matrix non-zero) → read `header.frame_id` from message, confirm it is present in `tf list` — a camera with zero `K` is uncalibrated; a camera whose `frame_id` is absent from TF produces wrong spatial results — see Rule 0 pre-flight |
| "read joint states / joint positions / joint angles / encoder values / current joint config / what are the joint positions" | Subscribe to JointState | Find `sensor_msgs/msg/JointState` → subscribe |
| "read wheel speeds / wheel velocities / wheel odometry" | Subscribe to JointState or Odometry | Find `sensor_msgs/msg/JointState` (check velocity fields) or Odometry twist fields |
| "read IMU / accelerometer / gyroscope / orientation data / angular velocity / linear acceleration / inertial data" | Subscribe to Imu | Find `sensor_msgs/msg/Imu` → subscribe |
| "read heading / compass / magnetic heading / magnetometer" | Subscribe to Imu or MagneticField | Find `sensor_msgs/msg/Imu` (orientation) or `sensor_msgs/msg/MagneticField` → subscribe |
| "read GPS / GNSS / latitude / longitude / fix / GPS coordinates" | Subscribe to NavSatFix | Find `sensor_msgs/msg/NavSatFix` → subscribe |
| "check battery / battery level / how much charge / power level / battery status / state of charge / voltage / remaining runtime" | Subscribe to BatteryState | `topics battery` (auto-discovers) or find `sensor_msgs/msg/BatteryState` |
| "read joystick / gamepad input / joystick data / controller input / joypad" | Subscribe to Joy | Find `sensor_msgs/msg/Joy` → subscribe |
| "read force / torque / wrench / FT sensor / force-torque sensor / load cell / contact force" | Subscribe to WrenchStamped | Find `geometry_msgs/msg/WrenchStamped` or `geometry_msgs/msg/Wrench` → subscribe |
| "read contact / bump sensor / collision / bumper" | Subscribe to contact/bumper topic | Find by type or keyword → subscribe |
| "read map / occupancy grid / current map / what does the map look like" | Subscribe to OccupancyGrid | Find `nav_msgs/msg/OccupancyGrid` → subscribe |
| "read costmap / local costmap / global costmap / navigation costmap" | Subscribe to costmap topic | Find `nav_msgs/msg/OccupancyGrid` with `costmap` in name → subscribe |
| "read the clock / ROS time / simulation time / what time is it in ROS" | Subscribe to /clock or get ROS time | Find `rosgraph_msgs/msg/Clock` → subscribe --max-messages 1 |
| "check diagnostics / diagnostic status / what's wrong / robot health / hardware errors / error messages / warnings / diagnostic aggregator" | Subscribe to diagnostics | `topics diag` or find `/diagnostics` topic → subscribe |
| **— TRANSFORMS (TF) —** | | |
| "where is X in Y frame / transform from X to Y / position of X relative to Y / pose of X in Y / X expressed in Y" | Look up TF transform | `tf list` (discover frames) → `tf lookup <source> <target>` |
| "stream transform / monitor TF / watch transform from X to Y / continuously get TF X to Y" | Echo TF transform continuously | `tf echo <source> <target>` |
| "is TF updating / TF health / TF alive / is the TF tree publishing / are transforms fresh" | Monitor TF update rate | `tf monitor` |
| "convert quaternion to euler / what's the roll pitch yaw / euler angles from quaternion / extract RPY / what's the yaw from this quaternion" | Convert quaternion → euler | `tf euler-from-quaternion` |
| "convert euler to quaternion / quaternion from roll pitch yaw / RPY to quaternion / degrees to quaternion" | Convert euler → quaternion | `tf quaternion-from-euler` |
| "transform point / where is point X in frame Y / reproject point to frame Y" | Transform a point between frames | `tf transform-point` |
| "transform vector / transform direction from X to Y / reproject vector" | Transform a vector between frames | `tf transform-vector` |
| "add static transform / publish fixed TF / broadcast constant TF / add fixed link / static broadcaster" | Publish a static TF | `tf static` |
| **— MOTION (mobile robot) —** | | |
| **Any motion word** + direction + **specific distance** (e.g. "move / drive / go / travel / head / proceed / advance / roll forward 1 m", "back up 0.5 m", "creep forward 10 cm", "nudge forward 0.05 m", "inch back 0.1 m") | Closed-loop distance if odom ≥ 5 Hz, else timed open-loop | **Odom ≥ 5 Hz** → `publish-until --field pose.pose.position --delta N --timeout <calc>`<br>**No odom** → `publish-sequence` duration `N/v`; notify user |
| **Any motion word** + direction + **specific angle** (e.g. "rotate / turn / spin / pivot / yaw / swing 90°", "turn left 45 degrees", "face right 180°", "turn around", "U-turn", "do a 180") | Closed-loop rotation if odom ≥ 5 Hz, else timed open-loop | **Odom ≥ 5 Hz** → `publish-until --rotate ±N --degrees --timeout <calc>`<br>**No odom** → `publish-sequence` duration `θ_rad/ω`; notify user |
| **Any motion word** + direction, **no target** (e.g. "move / drive / go / roll / head forward", "back up", "go right", "retreat", "pull back", "charge ahead") | Open-ended — run until stopped | `publish-sequence` move payload + zero payload |
| "strafe left / slide left / move sideways left / sidestep left" *(holonomic only)* | Strafe left — positive linear.y | Confirm holonomic → `publish-sequence` or `publish-until` with `linear.y > 0` |
| "strafe right / slide right / move sideways right / sidestep right" *(holonomic only)* | Strafe right — negative linear.y | Confirm holonomic → `publish-sequence` or `publish-until` with `linear.y < 0` |
| **Any motion word**, no direction, no target (e.g. bare "move", "drive", "go", "navigate") | Ambiguous — ask once (Rule 5 condition 3) | Ask: *"Which direction, and how far?"* |
| "stop / halt / freeze / stop moving / hold position / stand still / don't move" | Publish zero velocity | Find Twist/TwistStamped → publish zeros |
| "emergency stop / e-stop / STOP NOW / kill velocity / cut motors / abort motion / kill motion" | Emergency stop | `estop` (verify effect per Rule 8) |
| **— MANIPULATOR / ARM —** | | |
| "move arm / move joint / move to joint angles / move to position / send trajectory / execute trajectory / move to pose / reach X / extend arm" | Send JointTrajectory or FollowJointTrajectory action | Find `trajectory_msgs/msg/JointTrajectory` or `FollowJointTrajectory` action → send |
| "home the arm / go to home position / return to home / reset arm / go to zero / go to ready" | Send home trajectory or call home service | Find home service/action or send zero-position trajectory |
| "control gripper / open gripper / close gripper / grip / release / grab / let go / grasp / ungrasp" | Publish GripperCommand or trajectory | Find `control_msgs/msg/GripperCommand` or gripper trajectory topic → publish |
| **— SERVICES & ACTIONS —** | | |
| "call service X / trigger X / invoke X / reset X / clear X / initialize X / ping X / fire X / activate X via service" | Call a ROS 2 service | `services list` or `services find <type>` → `services call <service> <json>` |
| "reset the robot / reinitialize / factory reset / restart robot state" | Call reset service | Find reset/reinitialize service → `services call` |
| "set initial pose / tell the robot where it is / localize at X,Y / set pose estimate / AMCL initial pose" | Publish initial pose | Find `/initialpose` topic (`geometry_msgs/msg/PoseWithCovarianceStamped`) → publish |
| "clear costmap / clear the map / reset costmap / flush costmap" | Call clear_costmap service | Find `nav2_msgs/srv/ClearCostmapAroundRobot` or similar → `services call` |
| "save the map / export the map / write map to file" | Call map_saver service | Find map_saver service or action → call |
| "calibrate / run calibration / calibrate sensor X / tare X / zero the FT sensor" | Call calibration/tare service | Find calibration service → `services call` |
| "navigate to / go to pose / move to coordinates / send navigation goal / drive to X,Y / go to X,Y,Z" | Send navigation action (Nav2 / move_base) | `actions find NavigateToPose` or similar → `actions send <action> <goal_json>` |
| "dock / undock / auto-dock / return to base / go to charging station" | Send dock action or call dock service | Find dock action/service → send/call |
| "cancel navigation / abort goal / stop action / cancel goal / preempt / abort / never mind" | Cancel an action goal | `actions cancel <goal_id>` |
| "what's the navigation status / is navigation done / how far to the goal / navigation progress" | Monitor action feedback | `actions echo <action>` or check feedback from active goal |
| "watch service calls / monitor service X / echo service X / spy on service X" | Monitor service calls | `services echo <service>` |
| "watch action / monitor action X / echo action feedback / stream action feedback" | Monitor action feedback | `actions echo <action>` |
| **— LAUNCH & NODE EXECUTION —** | | |
| "start launch file / run launch file / launch X / bring up X / start bringup / start the robot / boot X / start X stack / spin up X / fire up X / initialize the robot / init bringup / start everything" | Start a launch file in tmux | `launch new <package> <launch_file>` — pass any launch args as positional `name:=value` pairs: `launch new <package> <launch_file> use_sim_time:=true robot_name:=my_bot`. **Never use `--config-path` for launch args** (it is for YAML params files only). **After a successful launch, run the Rule 0.6 source-mtime gate** (`find <profile.workspace>/src -newer <profile.json> -quit` over `package.xml`, `*.launch.{py,xml,yaml}`, `*.yaml`, `*.urdf`, `*.xacro`, `*.srdf`). If any path is printed, auto-rescan via `profile scan` with the original args and reload via `profile show`. If nothing is printed, skip the rescan. |
| "list launches / what's launched / running sessions / what launch files are running / show active launches / what's been started / what tmux sessions exist" | List active tmux launch sessions | `launch list` |
| "stop launch / kill launch / kill session X / stop bringup / shut down X / tear down X / kill everything / stop the robot / take down bringup" | Kill a tmux launch session | `launch kill <session>` |
| "restart launch / restart bringup / restart session X / relaunch X / bounce X / reload X / cycle X" | Restart a tmux launch session | `launch restart <session>` |
| "open foxglove / start foxglove / visualize robot / foxglove bridge / open the visualizer / open foxglove studio" | Start Foxglove via launch | `launch foxglove` |
| "start node X / run node X / run executable X / execute X node / spawn X node / bring up node X only" | Run a single node | `run new <package> <executable>` |
| **— BAG FILES —** | | |
| "record a bag / capture topics to bag / ros2 bag record / start recording / record ROS data / save a bag / bag record all topics" | Record ROS 2 data to a bag file (shell — Rule 2 exception; no `ros2_cli.py` bag record command yet) | Shell: `ros2 bag record -o <output_dir> <topic1> <topic2>` or `ros2 bag record -a` for all topics |
| "play back bag / replay bag / replay topics / ros2 bag play / play recorded data / play a bag" | Inspect bag first, then play back | `bag info <file>` to verify contents → Shell: `ros2 bag play <file>` |
| "bag info / what's in this bag / inspect bag / bag contents / bag topics / how long is the bag / bag duration / bag size / bag message count / bag metadata" | Get bag file metadata — topics, duration, size, message counts | `bag info <file>` |
| **— PARAMETERS —** | | |
| "what is X parameter / get X value / current value of X / what's X set to / read X param / what's the current X / show me X" | Get parameter value | `nodes list` → `params get <node:param>` |
| "what's the max speed / maximum velocity / top speed / speed limit / velocity limit / max linear / max angular" | Get velocity limit parameters | `nodes list` → `params list <node>` per node → find max/limit/vel params → `params get` |
| "what's the acceleration limit / max acceleration / accel cap / deceleration limit" | Get acceleration parameters | `nodes list` → find accel/decel params → `params get` |
| "set X to Y / change X parameter / configure X to Y / update X setting / adjust X / increase X to Y / decrease X to Y / lower X / raise X / turn up X / turn down X" | Set parameter value | `params describe` (type check) → `params set <node:param> <value>` → `params get` (verify) |
| "enable X / turn on X" *(as a boolean parameter)* | Set boolean param to true | `params describe` → `params set <node:param> true` → verify |
| "disable X / turn off X" *(as a boolean parameter)* | Set boolean param to false | `params describe` → `params set <node:param> false` → verify |
| "describe X parameter / what type is X / valid range of X / is X read-only / what values can X take / X constraints" | Describe parameter type and constraints | `params describe <node:param>` |
| "dump parameters / export config / save current params / dump all params / get all params from X" | Dump all params from a node | `params dump <node>` |
| "load parameters / restore config / load params from file / apply YAML to X / load config from file / use config file / load YAML params" | Load params from YAML file — **Rule 0 pre-flight required**: `params list <node>` + `params describe` each key before loading; verify with `params get` after | `params load <node> <file>` |
| "use params file / pass params file / launch with params file / --params-file / YAML params at launch / load parameters at startup" | Load params at launch time via `--params-file` | Run the node/launch with `--params-file <path>` — but first: `params list <node>` to compare YAML keys, `params describe` each to confirm types; re-verify with `params get` after the node is running |
| "delete parameter / remove param X" | Delete a parameter | `params delete <node:param>` |
| "save parameter preset / save config preset / save settings as X / save preset / snapshot parameters / save this config" | Save parameter preset to file | `params preset-save` |
| "load parameter preset / apply preset X / restore preset X / load saved settings / use preset X" | Load parameter preset | `params preset-load <name>` |
| "list presets / show saved presets / what presets exist / what parameter snapshots are there" | List saved parameter presets | `params preset-list` |
| "delete preset X / remove saved preset / clear preset X" | Delete a parameter preset | `params preset-delete <name>` |
| **— CONTROLLERS (ros2_control) —** | | |
| "load controller X / add controller X / register controller X" | Load a controller into the controller manager | `control load-controller <name>` |
| "unload controller X / remove controller X / drop controller X" | Unload a controller | `control unload-controller <name>` |
| "configure controller X / initialize controller X / set controller X to inactive / prep controller X" | Configure (transition to inactive) | `control configure-controller <name>` → verify `inactive` |
| "switch to X controller / activate X controller / enable X controller / use X controller / change controller to X / swap to X controller / put X controller in charge" | Switch active controllers | `control list-controllers` → `control switch-controllers --activate <new> --deactivate <old> --strictness STRICT` |
| "use position control / position controller / go to position mode" | Switch to position controller | Discover position controller name → switch-controllers |
| "use velocity control / velocity controller / go to velocity mode" | Switch to velocity controller | Discover velocity controller name → switch-controllers |
| "use trajectory control / joint trajectory controller / go to trajectory mode" | Switch to JointTrajectoryController | Discover trajectory controller name → switch-controllers |
| "pause controller X / stop controller X / deactivate controller X" | Set controller to inactive | `control set-controller-state <name> inactive` |
| "resume controller X / restart controller X" | Reactivate controller | `control set-controller-state <name> active` |
| "enable hardware / activate hardware component X / bring up hardware / enable actuator X / activate motor X" | Set hardware component state to active | `control set-hardware-component-state <name> active` |
| "disable hardware / deactivate hardware X / power down actuator X / disable motor X" | Set hardware component state to inactive | `control set-hardware-component-state <name> inactive` |
| **— LIFECYCLE NODES —** | | |
| "check lifecycle state / what state is X / is X active / X node status / is X configured / is X initialized" | Get lifecycle node state | `lifecycle get <node>` |
| "configure X node / initialize X lifecycle node / prep X node / set up X node" | Lifecycle configure transition | `lifecycle set <node> configure` → verify `inactive` |
| "activate X node / start X node / enable X node / bring up X node / bring X online / make X active" | Lifecycle activate transition | `lifecycle set <node> activate` → verify `active` |
| "fully start X node / configure and activate X / bring X fully online" | Full configure + activate sequence | `lifecycle set <node> configure` → verify `inactive` → `lifecycle set <node> activate` → verify `active` |
| "deactivate X node / stop X node / disable X node / pause X node / take X offline" | Lifecycle deactivate transition | `lifecycle set <node> deactivate` → verify `inactive` |
| "fully stop X node / deactivate and clean up X" | Full deactivate + cleanup sequence | `lifecycle set <node> deactivate` → `lifecycle set <node> cleanup` |
| "clean up X node / reset X lifecycle / cleanup X / unconfigure X" | Lifecycle cleanup transition | `lifecycle set <node> cleanup` → verify `unconfigured` |
| "shut down X node / shutdown X / kill X lifecycle node / finalize X" | Lifecycle shutdown transition | `lifecycle set <node> shutdown` → verify `finalized` |
| **— DIAGNOSTICS & HEALTH —** | | |
| "run health check / diagnose the robot / is everything OK / run diagnostics / check the system / ros2 doctor / any issues / anything broken / system check" | Run full ROS 2 health check | `doctor` |
| "why isn't X working / X isn't responding / X seems broken / troubleshoot X / debug X / X is not publishing" | Diagnose a specific problem | `doctor` + `nodes list` + `topics hz <X>` + `topics details <X>` + diagnose per Rule 7 |
| "is the robot ready to move / is the robot ready / can I send commands / is everything up" | Full readiness check | `doctor` + `nodes list` + `topics hz <ODOM_TOPIC>` + `control list-controllers` |
| "give me a full system overview / system summary / robot status overview / what's the full state" | Full system snapshot | `doctor` + `topics list` + `nodes list` + `control list-controllers` + `lifecycle nodes` |
| "test connectivity / test DDS / test network / test multicast / DDS reachability check" | Test DDS multicast connectivity | `doctor hello` |
| "check skill version / what version is this / what version of ros2_cli / skill info" | Get ros2_cli version | `version` |
| "is the daemon running / is ROS daemon up / ROS daemon status / daemon health / restart daemon / start daemon / stop daemon" | Check or control the ROS 2 daemon | `daemon status` to check; `daemon start` to start; `daemon stop` to stop |
| "what domain ID / ROS domain / what's ROS_DOMAIN_ID / which domain is active / domain collision / wrong nodes appearing" | Check ROS domain isolation | Inspect `ROS_DOMAIN_ID` env variable; run `nodes list` and verify expected nodes appear; if unexpected nodes from other systems appear, check domain ID collision — see Rule 0.1 Step 0 |
| "is ROS localhost only / is ROS isolated to localhost / can I reach across containers / cross-container ROS / is ROS_LOCALHOST_ONLY set" | Check cross-host/container visibility | Inspect `ROS_LOCALHOST_ONLY` env variable; if set to `1`, cross-container and cross-host topics are invisible — see Rule 0.1 Step 0 |
| "run tests / run test suite / run the tests / test package X / check if tests pass / execute tests / run unit tests / run integration tests / colcon test" | Run package tests (shell command — Rule 2 exception; ros2_cli.py has no test runner) | Shell: `colcon test --packages-select <pkg>` then `colcon test-result --verbose` to show failures |
| "what test results / did the tests pass / test report / show failures / test output / test summary" | Check colcon test results | Shell: `colcon test-result --all` or `colcon test-result --verbose` for failure details |
| **— ROBOT PROFILE —** | | |
| "build profile / scan robot / create profile / generate robot profile / scan workspace / analyse workspace / detect robot type / what kind of robot is this / create lekiwi profile / scan lekiwi" | Build a static robot profile from the workspace | `profile scan` — **if the user names a specific robot, pass `--name <robot_name>` (e.g. "create a profile for lekiwi" → `profile scan --name lekiwi`; "scan depthai" → `profile scan --name depthai`). The package filter is automatically derived from the name — only that robot's packages are scanned. You do NOT need to separately pass `--packages` unless you want a pattern different from the name. If no robot name is given (bare "create a profile" / "scan workspace"), omit `--name` entirely to scan the full workspace.** Add `--allow-live` if graph is up; `--robot-type TYPE` to override detection; `--packages` to use a multi-pattern filter (`--packages lekiwi,soarm`). |
| "show profile / load profile / what does the robot look like / robot summary / robot capabilities / what sensors does this robot have / what launch files are there / workspace overview" | Show robot profile summary (session-start: Rule 0.1 Step 7) | `profile show` — returns robot type, packages, launch files (as filenames), velocity topics, safety limits, sensor mounts, sensor flags, and any annotations |
| "show profile detail / full profile / detail for launch file X / launch args for X / yaml files for X / urdf for X" | Show per-launch-file detail (launch args, YAML, URDF, joint limits) | `profile show --section <launch-filename>` (e.g. `profile show --section bringup.launch.py`) |
| "update profile / refresh profile / rescan / re-scan workspace / rebuild profile / update robot profile / refresh launch file X / rescan lekiwi / rescan for lekiwi" | Rescan workspace and update profile | **If the user names a specific robot, pass `--name <robot_name>` (e.g. "rescan lekiwi" → `profile rescan --name lekiwi`; "rescan depthai packages" → `profile rescan --name depthai`). The package filter is automatically derived from the name — even if the stored `pkg_filter` is empty, it will be overridden with the name so the rescan never produces a full-workspace profile.** If no robot name is given (bare "rescan" / "re-scan workspace"), omit `--name`; the stored filter is reused automatically. Single-file fast rescan: `profile rescan --launch-file <filename>`. |
| "list profiles / what profiles exist / what robots have been scanned / show all profiles / profiles available" | List all saved profiles | `profile list` |
| "add note to profile / annotate robot / remember that / tell the agent / save a note / the camera is flipped / encoder drifts / add context" | Append a free-text annotation to the profile | `profile annotate "note text"` — persisted; shown at every session start; agent MUST read and apply |

### Step 2: Find What Exists

**ALWAYS start by exploring what's available:**

```bash
# These commands tell you everything about the system
python3 {baseDir}/scripts/ros2_cli.py topics list             # All topics
python3 {baseDir}/scripts/ros2_cli.py services list           # All services
python3 {baseDir}/scripts/ros2_cli.py actions list            # All actions
python3 {baseDir}/scripts/ros2_cli.py nodes list              # All nodes
python3 {baseDir}/scripts/ros2_cli.py tf list                 # All TF frames
python3 {baseDir}/scripts/ros2_cli.py control list-controllers # All controllers
```

### Step 3: Search by Message Type

**To find a topic/service/action, search by what you need:**

| Need to find... | Profile field (use first) | Live fallback (only when profile field absent) |
|-----------------|------------------|---|
| Velocity command topic (mobile) | `summary.cmd_vel_topic` | `topics find geometry_msgs/msg/Twist` AND `topics find geometry_msgs/msg/TwistStamped` |
| Velocity message type | `summary.velocity_topics[].type` | `topics type <topic>` |
| Position/odom topic | `summary.localization_config.fused_sources` values | `topics find nav_msgs/msg/Odometry` |
| TF frame names | `summary.tf_frames` | `tf list` |
| E-stop service | `summary.estop_config.service_name` | `services find std_srvs/srv/SetBool` |
| Joint positions | — | `topics find sensor_msgs/msg/JointState` |
| Joint trajectory (arm control) | — | `topics find trajectory_msgs/msg/JointTrajectory` |
| LiDAR data | — | `topics find sensor_msgs/msg/LaserScan` |
| Camera feed | — | `topics find sensor_msgs/msg/Image` AND `topics find sensor_msgs/msg/CompressedImage` |
| IMU data | — | `topics find sensor_msgs/msg/Imu` |
| Joystick | — | `topics find sensor_msgs/msg/Joy` |
| Battery/power | — | `topics find sensor_msgs/msg/BatteryState` |
| TF transforms (subscribe) | — | Subscribe to `/tf` or `/tf_static` |
| Diagnostics | — | `topics diag-list` (discovers by type) |
| Clock (simulated time) | `topics find rosgraph_msgs/msg/Clock` |
| Controller names | `control list-controllers` |
| Service by type | `services find <service_type>` |
| Action by type | `actions find <action_type>` |

### Step 4: Get Message Structure

**Before publishing or calling, always confirm the type and get the structure:**

```bash
# Confirm the exact message type of a discovered topic
python3 {baseDir}/scripts/ros2_cli.py topics type <discovered_topic>

# Get field structure (for building payloads)
python3 {baseDir}/scripts/ros2_cli.py topics message <confirmed_message_type>

# Get default values (copy-paste template)
python3 {baseDir}/scripts/ros2_cli.py interface proto <confirmed_message_type>

# Get service/action request structure
python3 {baseDir}/scripts/ros2_cli.py services details <service_name>
python3 {baseDir}/scripts/ros2_cli.py actions details <action_name>
```

### Step 5: Get Safety Limits (for movement)

**Fast-path: if a robot profile was loaded at session start (Rule 0.1 Step 6)**, use `summary.safety_limits.binding.linear_x` and `summary.safety_limits.binding.angular_z` as an initial hard ceiling before running the live sweep below. (`binding.linear_y` is set for holonomic robots; use it as the strafe ceiling if present.) Check `summary.safety_limits.sources` to understand which configs (teleop, nav2, controller) drove each limit. These are static values derived from workspace analysis — they capture limits baked into YAML configs and URDF at scan time. Pass them immediately via `--max-vel` / `--max-ang`. **When a valid profile is loaded, skip the live sweep below entirely.** The `binding` values already incorporate all YAML and URDF sources captured at scan time. Proceed directly to `control list-controllers` and the pre-motion stationary check.

**Also note:** `summary.teleop_limits.binding` gives the maximum speed the operator can command via joystick (axis scale at full deflection). Use this as the target speed when the user asks the robot to "move at full speed" or does not specify a speed.

**ALWAYS check for velocity limits before publishing movement commands. Scan every node.**

```bash
# Step 1: List every running node
python3 {baseDir}/scripts/ros2_cli.py nodes list

# Step 2: Dump all parameters from every node
python3 {baseDir}/scripts/ros2_cli.py params list <NODE_1>
python3 {baseDir}/scripts/ros2_cli.py params list <NODE_2>

# Step 3: Compute binding ceiling
# linear_ceiling  = min of all discovered linear limit values
# angular_ceiling = min of all discovered angular/theta limit values

# Step 4: Pass the ceiling into the publish command via --max-vel / --max-ang
# The flags clamp the velocity inside the CLI before the message is sent.
# This enforces the hardware limit even if the caller provides an out-of-range value.
python3 {baseDir}/scripts/ros2_cli.py topics publish-until <VEL_TOPIC> '<payload>' \
  --max-vel <linear_ceiling> --max-ang <angular_ceiling> \
  --monitor <ODOM_TOPIC> ...
# Or for publish-sequence / publish:
python3 {baseDir}/scripts/ros2_cli.py topics publish-sequence <VEL_TOPIC> '<msgs>' '<durs>' \
  --max-vel <linear_ceiling> --max-ang <angular_ceiling>
```

**If no limits are found on any node:** use conservative defaults (0.2 m/s linear, 0.75 rad/s angular) and pass them via `--max-vel 0.2 --max-ang 0.75`; tell the user the defaults were applied.

---

## Launch Commands & Workflow

### Auto-Discovery for Launch Files

**When user says "run the bringup" or "launch navigation" (partial/ambiguous request):**

**Planned native command (Wave 5):** `launch list <keyword>` will provide native keyword-filtered launch file discovery within ros2-skill, eliminating the need for the `ros2` CLI exceptions below. Until that command is available, use the following workflow.

1. **Discover available packages:**
   ```bash
   # ros2-skill has no package-listing command — this is a Rule 2 last-resort exception.
   # Document: ros2-skill has no equivalent for `ros2 pkg list`.
   ros2 pkg list
   ```

2. **Find matching launch files:**
   ```bash
   # ros2-skill has no launch-file listing command — this is a Rule 2 last-resort exception.
   # Document: ros2-skill has no equivalent for `ros2 pkg files`.
   ros2 pkg files <package>
   ```

3. **Intelligent inference (use context keywords):**

   | User says... | Search for packages / files containing... |
   |---|---|
   | "bringup", "bring up", "start the robot", "boot" | `bringup`, `bringup.launch.py` |
   | "navigation", "nav", "drive autonomously" | `navigation2`, `nav2`, `navigation` |
   | "camera", "vision", "image" | `camera`, `realsense`, `image_pipeline` |
   | "manipulation", "arm", "moveit" | `moveit`, `arm`, `manipulation` |
   | "simulation", "sim", "gazebo" | `gazebo`, `simulation`, `sim` |
   | exact package name given | use it directly |

4. **If exactly one clear match found:**
   - Launch it immediately — do not ask for confirmation (Rule 5)

5. **If multiple candidates found and cannot be disambiguated by context:**
   - Present options: "Found 3 launch files: X, Y, Z. Which one?" — this is the only case where asking is permitted

6. **If no match found:**
   - Search more broadly: check all packages for matching launch files
   - If still nothing: ask user for exact package/file name

### Launch Argument Validation

**How the CLI handles launch arguments:**

1. Arguments are **always passed through** to the launch command — the CLI never drops or silently modifies them.
2. The CLI calls `--show-args` on the launch file to get the declared arg list, then adds informational `NOTICE:` entries for any arg name not in that list (visible in the JSON output).
3. If `--show-args` fails, all provided args are passed through with a notice.
4. **The ROS 2 launch system is the authoritative validator.** It will report an error if an arg name is genuinely invalid.

**For the agent:**
- Always pass launch arguments as **positional args**: `launch new <pkg> <file> use_sim_time:=true robot_name:=my_bot`
- A `NOTICE:` in the output about an unrecognised arg name is informational — the arg was still passed.
- Do NOT use `--config-path` for launch arguments. `--config-path` is for YAML node-parameter files only.
- If the launch fails with an "unknown argument" error from ROS 2, check `profile show --section <launch_file>` to see declared args.

### Local Workspace Sourcing

**System ROS is assumed to be already sourced** (via systemd service or manually). The skill automatically sources any local workspace on top of system ROS.

**Search order:**
1. `ROS2_LOCAL_WS` environment variable
2. `~/ros2_ws`, `~/colcon_ws`, `~/dev_ws`, `~/workspace`, `~/ros2`

**Behavior:**
| Scenario | Behavior |
|----------|----------|
| Workspace found + built | Source automatically, run silently |
| Workspace found + NOT built | Warn user, run without sourcing |
| Workspace NOT found | Continue without sourcing (system ROS only) |

---

## Setup & Environment

### 1. Source ROS 2 environment
```bash
source /opt/ros/${ROS_DISTRO}/setup.bash
```

### 2. Install dependencies
```bash
pip install rclpy
```

### 3. Run on ROS 2 robot
The CLI must run on a machine with ROS 2 installed and sourced.

### Important: Check ROS 2 First
Before any operation, verify ROS 2 is available:
```bash
python3 {baseDir}/scripts/ros2_cli.py version
```

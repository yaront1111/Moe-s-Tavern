# ROS 2 Skill: Motion Rules

> **This file is part of a split rule set.** The full rule set spans five files:
> - [RULES-CORE.md](RULES-CORE.md) — general agent conduct, applies to every command
> - [RULES-PREFLIGHT.md](RULES-PREFLIGHT.md) — before every action: introspection, session-start, hardware readiness
> - **RULES-MOTION.md** ← you are here — motion workflow: discover → execute → estop → verify
> - [RULES-DIAGNOSTICS.md](RULES-DIAGNOSTICS.md) — when things go wrong: diagnose, verify, escalate
> - [RULES-REFERENCE.md](RULES-REFERENCE.md) — lookup tables: intent→command, launch workflow, setup

---

### Rule 3 — Movement algorithm (always follow this sequence)

For **any** user request involving movement — regardless of whether a distance or angle is specified — follow this algorithm exactly. Do not skip steps. Do not ask the user anything that can be resolved by running a command.

**Anti-rationalisation clause.** If a profile is loaded (Path A), running live-discovery commands for data the profile already holds is **a rule violation, not extra safety**. The common rationalisations — *"safety requires fresh introspection"*, *"my workflow is designed for maximum safety / to catch runtime changes"*, *"the profile is just a reference; control and safety must be done live"*, *"profile data alone is never enough for actuation"*, *"using the profile is only justified because it was just rescanned"* — are **all false in Path A** and are catalogued in Rule 13's anti-rationalisation table (RULES-CORE.md). The profile **is** the source of truth for static data; live calls are reserved for runtime state (controller active/inactive, stationary check, odom rate, payload template). Rule 0.0b is the mechanism for catching stale-profile cases; the agent does not get to bypass it with live discovery.

**Step 1 — Determine the velocity command topic and message type**

**Profile fast-path (mandatory when profile is loaded):**
- `VEL_TOPIC` = `summary.cmd_vel_topic` from the profile (e.g. `/base_controller/cmd_vel`)
- `VEL_TYPE` = `summary.velocity_topics[].type` for the entry whose topic matches `VEL_TOPIC` (e.g. `geometry_msgs/msg/TwistStamped`)

Do **not** run `topics find` or `topics type` when these profile fields are present. Using the wrong topic or type is the most common cause of silent failures and type assertion errors.

**Fallback (only when profile is absent or fields are missing):**
Run both searches in parallel:
```bash
topics find geometry_msgs/msg/Twist
topics find geometry_msgs/msg/TwistStamped
```
Record the discovered topic as `VEL_TOPIC`. Confirm the type:
```bash
topics type <VEL_TOPIC>
```
If both find commands return results, run `topics type` on each and use the returned type.

**Payload structure based on confirmed type:**
- `geometry_msgs/msg/Twist`: `{"linear":{"x":0.2,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}`
- `geometry_msgs/msg/TwistStamped`: `{"header":{"stamp":{"sec":0},"frame_id":""},"twist":{"linear":{"x":0.2,"y":0,"z":0},"angular":{"x":0,"y":0,"z":0}}}`

Always run `interface proto <VEL_TYPE>` once per session to get the exact field template — never construct from memory.

**Step 2 — Determine the odometry topic**

**Profile fast-path (mandatory when profile is loaded):**
- `ODOM_TOPIC` = first value in `summary.localization_config.fused_sources` (e.g. `/base_controller/odom`)

Do **not** run `topics find nav_msgs/msg/Odometry` when this profile field is present.

**Fallback (only when profile is absent or field is missing):**
```bash
topics find nav_msgs/msg/Odometry
```

**If a topic is found:** record it as `ODOM_TOPIC`. Then immediately verify it is live and publishing at a usable rate:
```bash
topics hz <ODOM_TOPIC> --duration 2
```
- **Rate ≥ 5 Hz:** odom is healthy — proceed with closed-loop.
- **Rate 1–4 Hz:** odom is too slow for reliable closed-loop. Warn the user: *"Odometry is publishing at <N> Hz — too slow for accurate closed-loop control. Proceeding open-loop."* Use `publish-sequence`.
- **Rate 0 Hz / timeout:** odom topic exists but nothing is publishing on it. Treat as absent (see below).

**If no odom topic found (or rate = 0 Hz):** attempt a TF-based position fallback before declaring "no position available":
```bash
tf list    # discover actual frame names (never hardcode)
```
If `<ODOM_FRAME>` and `<BASE_LINK_FRAME>` exist in the TF tree, they can be used for position queries via `tf lookup <ODOM_FRAME> <BASE_LINK_FRAME>` — but **not** for `publish-until` closed-loop monitoring (TF lookup is one-shot, not streamed). Fall back to `publish-sequence` and note in the report: *"No odometry topic found. TF is available for position queries but cannot be used for closed-loop motion control."*

**Step 3 — Choose the execution method**

**Closed-loop motion (`publish-until` with odometry monitoring) is always the required method when odometry is available.** Open-loop (`publish-sequence`) is a fallback of last resort, used only when odometry is confirmed unavailable. Never choose open-loop when an active `<ODOM_TOPIC>` has been found — even if the task "seems simple."

| Situation | Method |
|---|---|
| Distance or angle specified **and** odometry found | `publish-until` with `--monitor <ODOM_TOPIC>` — **closed loop, mandatory**; stops precisely on sensor feedback |
| Distance or angle specified **and** no odometry | `publish-sequence` with calculated duration — **open loop, last resort only**. Notify user: *"No odometry found. Running open-loop. Distance/angle accuracy is not guaranteed."* |
| No distance or angle specified (open-ended movement) | `publish-sequence` with a stop command as the final message |

**Step 4 — Execute using only discovered names**

Use `VEL_TOPIC` and `ODOM_TOPIC` from Steps 1–2. Never substitute `/cmd_vel`, `/odom`, or any other assumed name.

Distance commands:
```bash
topics publish-until <VEL_TOPIC> '<payload>' --monitor <ODOM_TOPIC> --field pose.pose.position.x --delta <N> --timeout <TIMEOUT>
```
Angle/rotation commands — **always use `--rotate`, never `--field` or `--yaw`**:
```bash
# CCW (left): positive --rotate + positive angular.z
topics publish-until <VEL_TOPIC> '<payload>' --monitor <ODOM_TOPIC> --rotate <+N> --degrees --timeout <TIMEOUT>
# CW (right):  negative --rotate + negative angular.z
topics publish-until <VEL_TOPIC> '<payload>' --monitor <ODOM_TOPIC> --rotate <-N> --degrees --timeout <TIMEOUT>
```
`--rotate` sign = direction. Positive = CCW. Negative = CW. `angular.z` sign must always match `--rotate` sign — mismatched signs cause timeout. There is no `--yaw` flag. Do not attempt to monitor orientation fields manually.

**`<TIMEOUT>` is never hardcoded — always calculate it:**

| Command type | Formula | Minimum |
|---|---|---|
| Linear distance `N` metres at `v` m/s | `ceil((N / v) * 2.0)` seconds | 15 s |
| Rotation `θ` degrees at `ω` rad/s | `ceil(((θ * π / 180) / ω) * 2.0)` seconds | 15 s |
| Open-ended `publish-sequence` | Use explicit durations per message — no global timeout needed | — |

Example: moving 3 m at 0.2 m/s → `ceil((3 / 0.2) * 2.0) = ceil(30) = 30 s`. Moving 0.5 m at 0.2 m/s → `ceil(5) = 15 s` (minimum applies). **Never use 30 s as a default — always calculate for the actual task.**

Open-ended or fallback (stop is always the last message):
```bash
topics publish-sequence <VEL_TOPIC> '[<move_payload>, <zero_payload>]' '[<duration>, 0.5]'
```

### Rule 9 — Pre-motion check: confirm the robot is stationary before commanding movement

**Before issuing any motion command**, perform all three pre-motion checks. Run steps A and B in parallel, then evaluate:

**A — Odom health and pose capture** (subscribe once):
```bash
topics subscribe <ODOM_TOPIC> --max-messages 1 --timeout 2
```
From this single message:
- **Record starting pose (baseline):** save `pose.pose.position.x`, `pose.pose.position.y`, and the orientation quaternion. This is the pre-motion reference for post-motion comparison and failure reports. Never use a cached pose — it must be fresh.
- **Check velocity:** all three of `twist.twist.linear.x`, `twist.twist.linear.y`, and `twist.twist.angular.z` must be **< 0.01** (m/s or rad/s). Values below this threshold are considered stationary. Values ≥ 0.01 mean the robot is moving or drifting.

**B — Node presence check** (run in parallel with A):
```bash
nodes list
```
Confirm the velocity controller node is still present (the same node discovered during Rule 0 pre-flight). If it has disappeared since pre-flight, the robot stack has changed — halt, run Rule 0.1 health check again, and do not proceed until the stack is verified.

**C — Odom frequency check** (run after A returns):
```bash
topics hz <ODOM_TOPIC> --duration 2
```
- Rate ≥ 5 Hz → proceed with closed-loop.
- Rate 1–4 Hz → warn user, fall back to open-loop.
- Rate 0 Hz → odom is stale despite the topic existing. Treat as absent. Fall back to open-loop.

**This check is mandatory before every motion command.** The odom rate from a previous motion or session cannot be assumed to still be valid — the odom publisher may have died, restarted, or changed rate between tasks.

**Evaluate results:**
- **Velocity ≥ 0.01 on any axis:** send `estop` immediately, verify it took effect (Rule 8 estop row), wait 0.5 s, re-read odom, then proceed. Report: *"Robot was already moving. Stopped before issuing new command."*
- **Subscribe timeout or rate = 0 Hz:** do NOT proceed with closed-loop. Fall back to `publish-sequence`. Notify user: *"Odometry not available. Running open-loop — distance accuracy not guaranteed."* No starting pose can be recorded; note in report.
- **Controller node absent:** halt. Re-run Rule 0.1 health check. Do not proceed until the velocity controller is confirmed running.

**Hard gate — if pre-motion recovery fails:** If the robot was moving and `estop` fails to stop it within the verification window (Rule 8), or if the controller node is absent and does not reappear after `doctor`, **do not proceed with any motion command**. Escalate immediately: *"Pre-motion checks failed and recovery was unsuccessful. Manual intervention required."* A failed pre-motion check that is overridden by proceeding anyway is a safety violation.

**Carry-forward baseline for sequential moves:** For tasks involving multiple sequential move commands, the confirmed final position from the previous move (recorded after the post-motion two-phase odom read, Rule 8) serves as the pre-motion baseline for the next move — do not re-subscribe for a pose if you already have a fresh stationary reading from the prior move's completion. However, the velocity check (step A) and odom rate check (step C) must still run fresh for every motion command — they cannot be carried forward.

**Long-motion segmentation to detect stale odom:** For any `publish-until` where the expected duration exceeds 30 s (estimated as `distance_m / linear_speed_m_s` or `angle_deg / angular_speed_deg_s`), break the motion into max-30 s segments. Between segments: send `estop`, verify stopped, run `topics hz <ODOM_TOPIC> --duration 1` to confirm odom is still live, re-record the current position as the new baseline, then issue the next segment for the remaining distance/angle. This ensures odom health is verified at each segment boundary and limits the maximum exposure to a stale-odom silent failure.

**Never issue a new motion command on top of an existing one without stopping first.** Overlapping velocity commands cause unpredictable trajectories and runaway motion.

**Nav2 goal preemption (SG-9) — check before every new motion command:**
Before issuing any velocity command (`publish-until`, `publish-sequence`, `topics publish`) or a new `nav2 go`, check whether a Nav2 action goal is currently in flight.

**Preferred (nav2 commands available):**
```bash
nav2 status      # → nav2_available + active_goal (null if no goal in flight)
nav2 cancel      # cancel all goals + send zero-velocity burst in one call
```
If `nav2 status` returns `active_goal: null`, no goal is in flight — proceed. If `active_goal` is non-null, run `nav2 cancel` and wait for the command to return before issuing the new motion command.

**Fallback (nav2 commands unavailable — e.g. nav2_msgs not installed):**
```bash
actions list   # look for NavigateToPose or NavigateThroughPoses with an active goal
```
If an active Nav2 goal is found:
1. Run `actions cancel <goal_id>` — use the goal ID from the `actions list` output.
2. Verify the goal status reaches `CANCELED`: subscribe to the action feedback or re-run `actions list`.
3. Only then issue the new motion command.

**Why:** Nav2's path follower re-issues velocity commands to `/cmd_vel` on every control cycle. Any concurrent `publish-until` or manual velocity command will be overridden on the next Nav2 cycle — the robot ignores your command silently. Rule 23 handles estop when a new command arrives during in-flight velocity; this rule handles the Nav2 action-goal conflict that Rule 23 alone cannot resolve.

### Rule 17 — Follow REP-103 and REP-105 at all times

ROS 2 has standardised units, coordinate conventions, and frame conventions. Violating them produces silent wrong results — wrong yaw, wrong direction, wrong distance — with no error from the CLI.

#### REP-103: Standard Units and Coordinate Conventions

**Units — all message values use SI units. No exceptions.**

| Quantity | Unit | Never use |
|---|---|---|
| Linear distance | metres (m) | cm, mm, inches |
| Linear velocity | m/s | cm/s, km/h |
| Angular position | radians (rad) | degrees (in payloads) |
| Angular velocity | rad/s | deg/s, RPM |
| Time | seconds (s) | ms unless in a `builtin_interfaces/Time` stamp |
| Frequency | Hz | — |

**The `--degrees` flag in `publish-until --rotate` and `--rotate --degrees` is a CLI convenience only.** The underlying `angular.z` in the Twist/TwistStamped payload is always rad/s. Never put degrees into a message field.

**Coordinate frame convention (right-hand rule):**

| Axis | Direction |
|---|---|
| x | Forward |
| y | Left |
| z | Up |

- Positive `linear.x` → robot moves **forward**
- Negative `linear.x` → robot moves **backward**
- Positive `linear.y` → robot strafes **left** *(holonomic platforms only — has no effect on differential-drive robots)*
- Negative `linear.y` → robot strafes **right** *(holonomic only)*
- Positive `angular.z` → robot rotates **CCW (left)** when viewed from above
- Negative `angular.z` → robot rotates **CW (right)**
- This matches the `--rotate` sign convention: positive = CCW, negative = CW

**Holonomic vs. differential-drive:** before commanding `linear.y`, confirm the robot is holonomic (e.g., mecanum or omni wheels). On a differential-drive robot, `linear.y` is silently ignored — use `angular.z` followed by `linear.x` to achieve lateral repositioning instead.

**Quaternion field order in all ROS 2 messages is `(x, y, z, w)` — never `(w, x, y, z)`.**

**Yaw from odometry quaternion (2D mobile robot — pure z-rotation):**
```
yaw_rad = 2 * atan2(q.z, q.w)
yaw_deg = yaw_rad * (180 / π)
```
This simplified formula is valid when `q.x ≈ 0` and `q.y ≈ 0` (flat-ground robot). For a 3D platform, use the full euler extraction formula. Verify `q.x` and `q.y` are near zero before using the simplified form.

**Never:**
- Put degree values into `angular.z` or any rotation field in a message
- Assume the quaternion order is `(w, x, y, z)` — ROS 2 uses `(x, y, z, w)`
- Use `angular.z` with opposite sign to `--rotate` — they must always match

#### REP-105: Coordinate Frames for Mobile Platforms

**The standard frame hierarchy is:**
```
map → odom → base_link (→ sensor frames)
```

| Frame | Properties | Use for |
|---|---|---|
| `base_link` | Attached to robot body | Relative transforms from the robot |
| `odom` | Continuous, no jumps — drifts over time | Closed-loop motion tracking; `publish-until` delta monitoring |
| `map` | Globally accurate — may jump when localisation corrects | Absolute position queries; navigation goals |

**For closed-loop motion (publish-until):** monitor position delta in the `odom` frame — use `pose.pose.position.x` (or `.y`) from `nav_msgs/Odometry`, which is expressed in the `odom` frame. This is correct for tracking relative displacement.

**For absolute position queries** (e.g., "where is the robot on the map?"): look up the `map` → `base_link` transform via `tf lookup`. The `odom` frame position drifts; the `map` frame is corrected by localisation (AMCL, Cartographer, etc.).

**Never:**
- Use the `map` frame position from an odometry message — odometry is expressed in `odom`, not `map`
- Use the `odom` frame for absolute global position when a localiser is running — use `map` instead
- Assume frame names are exactly `map`, `odom`, `base_link` without first running `tf list` (Rule 0) — they may be namespaced (e.g., `/robot_1/odom`)
- Confuse a jump in `map` → `odom` (localisation correction) with the robot physically moving
- Consume spatial sensor data without first verifying the sensor's `frame_id` exists in the TF tree and is not stale — run `tf list` and `tf echo <SENSOR_FRAME> <BASE_FRAME>` before using any sensor's spatial output

**TF tree pre-flight validation — run before any TF-dependent operation:**
Before any `tf lookup`, `tf echo`, or spatial sensor usage:
1. Run `tf list` — confirm the expected frames are present. If the list is empty, TF is not publishing; escalate and halt any spatial operation.
2. For each frame you intend to use, confirm it appears in `tf list` output. If a required frame is absent: it may not have been broadcast yet (DDS lag), or the node responsible for it has crashed. Wait 2 s and retry once before escalating.
3. For any sensor frame (camera, LiDAR, IMU): run `tf echo <SENSOR_FRAME> <BASE_FRAME> --duration 1` to confirm the transform is actively updating and not stale. A stale transform (last updated > 1 s ago) means the sensor is not publishing its frame — do not use the sensor's spatial output. For ongoing staleness monitoring during a multi-step spatial task, use `tf monitor <FRAME>` — it reports when the transform was last updated and flags if it has gone silent, without requiring a fixed duration window.
4. **TF cycle detection** — a TF tree with a cycle (e.g., `odom → base_link → odom`) causes `tf lookup` to hang indefinitely. If a `tf echo` or `tf lookup` call hangs past its timeout, suspect a cycle. Run `tf validate` to perform automated DFS cycle detection and multiple-parent checks across the full TF graph. If `tf validate` reports any cycles or multi-parent frames, halt all spatial operations and report the offending frames before proceeding.

---

### Rule 18 — Always run `estop` after `publish-until` and `publish-sequence`, regardless of outcome

**Rule 18 is a hard preemption rule.** On any `publish-until` or `publish-sequence` exit — condition met, timeout, normal completion, or exception — `estop` is the **first and only permitted action**. No diagnostic, no odometry read, no report, no retry, no recovery attempt may begin until `estop` has been sent **and** verified (odom velocity < 0.01 on all axes). This sequencing is absolute: safety before information.

**Built-in auto-hold (code-level guarantee):** Both `publish-until` and `publish-sequence` now send a zero-velocity burst automatically in their `finally` blocks — on every exit path including exceptions and `KeyboardInterrupt`. For `publish-until`, 10 zero-velocity messages are sent at 50 ms intervals; for `publish-sequence`, 3 messages at 50 ms intervals. This applies only to Twist / TwistStamped payloads; non-motion sequences are unaffected. This is a best-effort hardware stop — it does **not** replace `estop`.

**Why `estop` is still mandatory even with auto-hold:**
- The zero-velocity burst is sent by the CLI process. If the process crashes, is killed (SIGKILL), or the DDS publisher goes out of scope before all messages are sent, the burst may be incomplete.
- `estop` verifies the stop: it checks that odom velocity drops below 0.01 on all axes, confirming the velocity controller received and applied the stop command.
- The velocity controller may continue executing the last commanded velocity if the publisher disconnects before the burst completes.

**Mandatory post-motion protocol:**

```bash
# Always run estop immediately after publish-until or publish-sequence, before anything else
python3 {baseDir}/scripts/ros2_cli.py estop
```

Apply this rule in all exit cases:

| Motion command exit reason | `estop` required? | Rationale |
|---|---|---|
| `publish-until`: condition met (`condition_met: true`) | **Yes** | Auto-hold sent burst; `estop` verifies stop took effect |
| `publish-until`: timeout (`condition_met: false`) | **Yes — first priority** | Auto-hold sent burst; verify before diagnosing |
| `publish-until`: exception / error | **Yes** | Auto-hold sent burst; unknown state — verify before recovery |
| `publish-sequence`: normal completion | **Yes** | Auto-hold sent burst; verify velocity is actually zero |
| `publish-sequence`: exception / error | **Yes** | Auto-hold sent burst; unknown state — verify before recovery |

**After timeout specifically:** send `estop` before diagnosing whether the condition was met, before re-reading odometry, before considering a retry, before reporting to the user. The robot may still be moving at commanded velocity. Stopping is always safe; not stopping is never safe.

**Verify `estop` took effect (Rule 8):** subscribe to `<ODOM_TOPIC>` and confirm all velocity axes < 0.01 within 5 s (10 s for heavy platforms > 20 kg). If velocity remains non-zero after the window, report a critical failure — the velocity controller may have disconnected.

**This rule supersedes any perceived urgency to diagnose quickly.** An unstopped robot during diagnosis creates a moving-hazard context that makes every subsequent action more dangerous.

**Process interrupt (Ctrl+C / SIGTERM) cleanup:**
If the `ros2_cli.py` process is interrupted (keyboard interrupt, SIGTERM, or any unhandled exception) while a motion command is in progress, the `try/finally` auto-hold block fires and attempts the zero-velocity burst before the process exits. However, if the process is killed with SIGKILL (signal 9) or crashes at OS level, no `finally` block can run.

**What the agent must do if it detects a mid-motion interruption:**
- If control returns to the agent after an interrupted motion command (e.g., the CLI process exited with a non-zero code mid-publish), treat it identically to a Rule 18 exception case: **send `estop` immediately** before doing anything else.
- Do not assume the robot stopped because the CLI process exited. The velocity controller continues executing the last commanded velocity until it receives a stop command or times out.
- Do not assume the auto-hold fired — SIGKILL bypasses all `finally` blocks.

**What should exist in the CLI (for awareness):**
`ros2_cli.py` should register a `signal.signal(signal.SIGTERM, ...)` handler that sends `estop` and then exits cleanly. This is a known gap — tracked as a CLI improvement. Until it is implemented, the agent must treat any abrupt CLI exit as a potential coasting-robot event and issue `estop` as the first recovery action.

### Rule 20 — Deceleration zone: auto-computed for every `publish-until` move

The deceleration zone ramps velocity down linearly from full commanded speed to a fine-control floor over the final N units of a movement. Without it, the robot arrives at full velocity and overshoots any platform with non-negligible inertia.

**The skill computes the zone automatically** from the commanded velocity and discovered params. Do not add `--slow-last` manually unless you need to override the computed value.

#### How auto-compute works

For **linear** moves:
```
a_max     = param scan (max_accel / accel_limit / decel_limit); fallback 0.5 m/s²
v_min     = param scan (min_vel_x / min_vel / min_speed);       fallback: x=0.125 m/s, y=0.1 m/s
v_cmd     = |linear.x| or |linear.y| (x preferred)

slow_last = clamp( v_cmd² / (2 × a_max),  min=0.05 m,  max=distance × 0.4 )
slow_factor = clamp( v_min / v_cmd,  min=0.10,  max=0.50 )
```

For **rotation** moves:
```
α_max     = param scan (max_ang_accel / ang_accel_limit);       fallback 1.0 rad/s²
ω_min     = param scan (min_ang_vel / min_angular_speed);       fallback 0.375 rad/s
ω_cmd     = |angular.z|

slow_last = clamp( ω_cmd² / (2 × α_max),  min=3°,  max=angle × 0.4 )
slow_factor = clamp( ω_min / ω_cmd,  min=0.10,  max=0.50 )
```

Param fetch runs at startup with a **2 s hard timeout**. If no matching params are found, the fallback defaults above are used silently. The computed values are reported in the output JSON under `"decel_zone"`.

**Example output:**
```json
"decel_zone": {
  "auto_computed": true,
  "slow_last": 0.32,
  "slow_factor": 0.28,
  "params_source": "/velocity_controller:max_accel"
}
```

#### Manual override

If `--slow-last` is provided explicitly, auto-compute is skipped entirely and the provided value is used as-is. Use this only if the computed zone produces observed overshoot or when testing:

```bash
# Manual override — suppress auto-compute
python3 {baseDir}/scripts/ros2_cli.py topics publish-until <VEL_TOPIC> \
  '{"linear":{"x":0.4},"angular":{"z":0.0}}' \
  --monitor <ODOM_TOPIC> --field pose.pose.position.x --delta 3.0 \
  --slow-last 0.5 --slow-factor 0.3
```

#### Fallback defaults (when params unavailable)

| Axis | Fine-control floor (`v_min`) | Accel fallback (`a_max`) |
|------|------------------------------|--------------------------|
| linear.x | 0.125 m/s | 0.5 m/s² |
| linear.y | 0.100 m/s | 0.5 m/s² |
| angular.z | 0.375 rad/s | 1.0 rad/s² |

**If overshoot is observed** with auto-computed values: increase `--slow-last` (larger zone) or decrease `--slow-factor` (lower floor). Report both values from `"decel_zone"` output so the user can see what was used.

### Rule 21 — After a `publish-until` timeout, verify position before re-issuing

When `publish-until` exits with `condition_met: false`, the robot did not reach the intended target. The robot's actual position is unknown — it may have moved partway, not at all, or past the target (e.g., if the condition field was being read incorrectly).

**Mandatory re-issue protocol:**

1. **Stop the robot first** (Rule 18 — estop always).
2. **Subscribe to odom and record the current position:**
   ```bash
   topics subscribe <ODOM_TOPIC> --max-messages 1 --timeout 5
   ```
3. **Compare current position to the pre-motion baseline** (recorded per Rule 9).
4. **Determine remaining distance/angle** from the delta, then decide:
   - If remaining > 0 → issue a new `publish-until` for the remaining distance only.
   - If remaining ≈ 0 (position already reached despite `condition_met: false`) → report success with a note about the monitoring field.
   - If position is unknown (odom unavailable) → **do not re-issue**. Report to the user and fall back to open-loop only if explicitly authorised.

**Never re-issue the original full command.** Sending the same distance/angle again from a partially-moved position will overshoot the target by whatever distance was already covered.

**Near-success case:** When `publish-until` returns `condition_met: false`, read odom and compute the delta from the pre-motion baseline. If delta ≥ (target − 0.05 m) for linear moves, or delta ≥ (target − 3°) for rotations, treat as success — the robot is within tolerance. Report actual distance/angle moved and note the monitoring field may need adjustment if tolerance was reached this way consistently. Do not re-issue.

**If two consecutive `publish-until` calls timeout on the same move:** escalate to the user. Do not attempt a third retry autonomously. Report: current position, target, remaining distance, and the reason for the timeouts (QoS? Odom dropout? Velocity controller issue?).

### Rule 22 — Reject unreasonably large motion commands without explicit confirmation

Motion commands with extreme distances or angles are almost always operator errors, not genuine intent. Executing them unverified risks uncontrolled traversal of large areas or repeated spinning.

**Hard ceilings — reject without explicit confirmation:**

| Motion type | Ceiling |
|---|---|
| Linear (any direction) | > 50 m in a single command |
| Rotation | > 3600° (10 full turns) in a single command |

**Soft warning — execute but report the assumption:**

| Motion type | Range | Action |
|---|---|---|
| Linear | 10–50 m | Execute, but include in report: *"Long move: X m requested. Robot will take approximately Y s at Z m/s. Monitoring for safety."* |
| Rotation | 360–3600° | Execute with mandatory `--slow-last` (Rule 20), report: *"Multi-turn rotation: X° requested."* |

**If a ceiling is exceeded**, stop and report: *"Requested distance/angle (X m / X°) exceeds the maximum safe single-command ceiling (50 m / 3600°). Please confirm this is intentional, or break the move into segments."* Do not execute until the user explicitly re-confirms.

**This ceiling does not apply to open-loop `publish-sequence`** (no distance target) — the user's stop command or a duration flag bounds those commands instead.

### Rule 23 — Any new command received while motion is active: stop first

If the user sends a new command (any kind) while a `publish-until` or `publish-sequence` motion is executing, the in-flight motion must be stopped before the new command is handled.

**Protocol:**

1. **Send `estop` immediately** — before processing the new command at all.
2. **Verify estop took effect** (Rule 8 estop row: odom velocity < 0.01 within 5 s).
3. **Then handle the new command** as a fresh request from a stationary robot.

**Never run two motion commands in parallel.** Overlapping velocity commands produce unpredictable trajectories. The user's new command is not pre-approval for skipping the stop.

**If the new command is itself "stop" / "halt" / "estop":** treat it as a direct estop request — send `estop` immediately, verify, report. No motion resumes until the user issues a new motion command.

**This rule applies regardless of how much of the original motion had completed.** Even if the robot was 1 cm from its target, stop on receipt of a new command.

### Rule 24 — Conditional and branching task sequences

Rule 16 (RULES-DIAGNOSTICS.md) defines how to execute a linear sequence (step N → verify → step N+1). This rule extends that to tasks with branches, fallbacks, and retry limits.

#### When a task has a conditional structure

Some tasks cannot be resolved as a linear sequence because the next action depends on the outcome of the current one. Examples:
- "Move to position X; if you can't reach it after two tries, report where you ended up"
- "Try to activate controller A; if it fails, try controller B instead"
- "Attempt closed-loop; if odom is unavailable, fall back to open-loop"

**General conditional pattern:**

```
attempt = 1
max_attempts = 2  # default unless user specifies otherwise

while attempt ≤ max_attempts:
  Execute step N
  If step N succeeds → proceed to next step (or complete task)
  If step N fails:
    If attempt < max_attempts:
      Diagnose (Rule 7), adjust parameters if possible, increment attempt
    If attempt == max_attempts:
      Escalate (see escalation rules below)
```

#### Retry rules

| Situation | Max autonomous retries | Action on max reached |
|---|---|---|
| Motion command timeout (`publish-until`) | 1 (remaining distance only, Rule 21) | Escalate: position, target, remaining, cause |
| Verification failure (Rule 8 retry protocol) | 2 (3 total attempts) | Escalate as critical failure |
| Discovery empty result (Rule 10 retry) | 1 (broadened search after 1 s) | Ask user or declare unavailable |
| General step failure (not covered above) | 1 | Escalate |
| Safety-related failure (estop, controller offline) | 0 — escalate immediately | No autonomous retry on safety failures |

**Never retry more times than the table above specifies.** Autonomous retry loops without bounds create unpredictable behaviour and mask the root cause.

#### Fallback chains

When a preferred method fails and a known fallback exists, execute the fallback without asking:

| Preferred | Fallback condition | Fallback action |
|---|---|---|
| `publish-until` (closed-loop) | No odom / QoS mismatch | `publish-sequence` (open-loop) — notify user |
| Discovered topic | Empty result from all `topics find` | Ask user for topic name (genuine ambiguity) |
| Discovered launch file | No keyword match | Broader search → if still empty, ask |
| Controller A | Controller A fails to activate | Try controller B if one exists; else escalate |

**Always notify the user when a fallback fires.** Include: what was tried, why it failed, what the fallback is, and what accuracy/safety implications the fallback has (e.g., "Running open-loop — distance not guaranteed").

#### Escalation rules

Escalate to the user (one clear, factual message) when:
1. Max retries exhausted — include: last known position, target, remaining distance/angle, root cause
2. No fallback is available for a failed step
3. Any safety check fails and cannot recover (estop unverified, controller offline and unreachable)
4. Two consecutive attempts produce the same failure — do not attempt a third

**When escalating, always provide:** what was tried, what failed, current system state (position, controller state), and one specific suggested next step. Never present a list of options — recommend one action.

---

### Rule 25 — Proximity sensor discovery before long motions

Before any motion whose estimated duration exceeds **5 seconds** (i.e., `distance / v_cmd > 5 s`), run a proximity sensor discovery scan. This is a pre-flight check — it does not block motion and does not require a sensor to be present.

#### Discovery procedure

Run the following three `topics find` calls in parallel (or sequentially with short timeouts):

```bash
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/LaserScan
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/Range
python3 {baseDir}/scripts/ros2_cli.py topics find sensor_msgs/msg/PointCloud2
```

#### Outcome rules

| Result | Action |
|--------|--------|
| One or more proximity topics found | Note the discovered topic(s) in the motion report. Proceed with motion. |
| No proximity topics found | Skip silently — **do not warn the user**. Proceed with motion. |

**Never block or delay motion because no proximity sensor was found.** The sensor check is advisory only. Its purpose is to surface available sensor information that the user or a future real-time integration could act on.

#### What to report when a sensor is found

Include in the motion result (alongside `decel_zone`, position, etc.):

```json
"proximity_sensors": [
  {"topic": "/scan", "type": "sensor_msgs/msg/LaserScan"},
  {"topic": "/ultrasonic_front", "type": "sensor_msgs/msg/Range"}
]
```

If no sensor is found, omit the `"proximity_sensors"` key entirely from the output.

#### Soft/hard stop thresholds (for real-time integration — reference only)

Full real-time obstacle avoidance requires a platform-specific integration loop not available in this CLI skill. The thresholds below are documented for reference and for any future integration:

| Range reading | Recommended action |
|---------------|-------------------|
| < 0.5 m | Reduce commanded velocity to 25% of current speed |
| < 0.2 m | Send `estop` immediately |

These thresholds cannot be enforced from the CLI without a continuous sensor subscription running in parallel with the publish loop. Do not attempt to approximate this with sequential subscribe-then-publish calls — the latency is too high to be safe.

#### Short motions (≤ 5 s estimated duration)

Skip the proximity scan entirely. The overhead of the `topics find` calls is not justified for short moves.

---

## Action Preemption — `actions cancel` vs `estop`

Use this decision table whenever an in-flight action goal needs to be stopped:

| Situation | Action | Reason |
|-----------|--------|--------|
| Goal is running but user wants to abort gracefully | `actions cancel <action>` | Sends a cancel request to the action server; the server winds down cleanly |
| Goal is running and the robot is moving unsafely / not stopping | `estop` first, then `actions cancel <action>` | `estop` publishes zero velocity immediately; cancel cleans up the goal state |
| Goal was rejected or timed out (robot not moving) | `actions cancel <action>` | No motion risk; cancel clears the goal state |
| Action server crashed / no longer responding | `estop` | No action server to receive cancel; stop the actuators directly |
| Goal completed but robot is still drifting / coasting | `estop` | Motion is no longer governed by the goal; velocity command is needed |

**Rule:** If in doubt, send `estop` first — it is always safe. Then send `actions cancel` to clean up goal state. Never skip `estop` when the robot is or may be moving.

---

## Motion Error Recovery

### Movement / publish-until Failures

**A `publish-until` timeout is a robot or sensor issue — not a missing command.** `publish-until` exists and works; the timeout means the odometry delta was never reached. Do not conclude the command is unavailable.

| Error | Recovery |
|-------|----------|
| `publish-until` times out without reaching target | 1. **Immediately send `estop`** — do not wait, do not retry, do not ask the user first<br>2. Subscribe to `<ODOM_TOPIC>` — check if odom is publishing and values are changing<br>3. Run `topics hz <ODOM_TOPIC>` — if rate < 5 Hz, odom is stale (robot may not have moved)<br>4. Run `control list-controllers` to verify the velocity controller is active<br>5. Report to user: actual distance covered, odom status, controller state |
| Odometry not updating during motion | 1. Immediately send zero-velocity: `estop`<br>2. Check `topics details <ODOM_TOPIC>` for publisher count and `topics hz <ODOM_TOPIC>` for rate<br>3. Do NOT continue publishing if odometry is stale — it is a runaway risk |
| `Could not detect message type` for topic | The topic exists but has no publisher yet. Check `topics details <topic>` for publisher count. Wait for the publisher to connect, or pass `--msg-type` explicitly. |

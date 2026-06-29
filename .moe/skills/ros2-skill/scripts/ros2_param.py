#!/usr/bin/env python3
"""ROS 2 parameter commands."""

import json
import os
import re
import time
import types

import rclpy
from rcl_interfaces.msg import Parameter, ParameterValue

from ros2_utils import ROS2CLI, output, parse_node_param, ros2_context


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _norm_node(name):
    """Ensure node name starts with '/'."""
    return name if name.startswith('/') else '/' + name


def _call_service(node, srv_type, service_name, request, timeout, retries=1):
    """Call a ROS 2 service and return (result, error_dict).

    Returns (result, None) on success or (None, {"error": "..."}) on failure.
    Creates and destroys its own client so callers stay clean.
    """
    client = node.create_client(srv_type, service_name)
    try:
        for attempt in range(retries):
            last_attempt = (attempt == retries - 1)
            if not client.wait_for_service(timeout_sec=timeout):
                if not last_attempt:
                    continue
                return None, {"error": f"Parameter service not available: {service_name}"}
            future = client.call_async(request)
            end_time = time.time() + timeout
            while time.time() < end_time and not future.done():
                rclpy.spin_once(node, timeout_sec=0.1)
            if future.done():
                return future.result(), None
            future.cancel()
            if not last_attempt:
                continue
        return None, {"error": f"Timeout calling {service_name}"}
    finally:
        client.destroy()


def _param_value_to_python(v):
    """Convert a rcl_interfaces ParameterValue to a native Python value."""
    if v.type == 1:
        return v.bool_value
    elif v.type == 2:
        return v.integer_value
    elif v.type == 3:
        return v.double_value
    elif v.type == 4:
        return v.string_value
    elif v.type == 5:
        return list(v.byte_array_value)
    elif v.type == 6:
        return list(v.bool_array_value)
    elif v.type == 7:
        return list(v.integer_array_value)
    elif v.type == 8:
        return list(v.double_array_value)
    elif v.type == 9:
        return list(v.string_array_value)
    return None


def _infer_param_value(value):
    """Infer ParameterValue type from a native Python value."""
    pv = ParameterValue()
    if isinstance(value, bool):
        pv.type = 1
        pv.bool_value = value
    elif isinstance(value, int):
        pv.type = 2
        pv.integer_value = value
    elif isinstance(value, float):
        pv.type = 3
        pv.double_value = value
    elif isinstance(value, str):
        pv.type = 4
        pv.string_value = value
    elif isinstance(value, (list, tuple)) and value:
        first = value[0]
        if isinstance(first, bool):
            pv.type = 6
            pv.bool_array_value = list(value)
        elif isinstance(first, int):
            pv.type = 7
            pv.integer_array_value = list(value)
        elif isinstance(first, float):
            pv.type = 8
            pv.double_array_value = list(value)
        elif isinstance(first, str):
            pv.type = 9
            pv.string_array_value = list(value)
        else:
            pv.type = 4
            pv.string_value = str(value)
    else:
        pv.type = 4
        pv.string_value = str(value)
    return pv


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_params_list(args):
    try:
        from rcl_interfaces.srv import ListParameters
        with ros2_context():
            node = ROS2CLI()
            node_name = _norm_node(parse_node_param(args.node)[0])
            result, err = _call_service(
                node, ListParameters, f"{node_name}/list_parameters",
                ListParameters.Request(), args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        names = result.result.names if result.result else []
        formatted = [f"{node_name}:{n}" for n in names]
        output({"node": node_name, "parameters": formatted, "count": len(formatted)})
    except Exception as e:
        output({"error": str(e)})


def cmd_params_get(args):
    if getattr(args, 'param_name', None):
        full_name = args.name.rstrip(':') + ':' + args.param_name
    else:
        full_name = args.name
    if ':' not in full_name or not full_name.split(':', 1)[1]:
        return output({"error": "Use format /node_name:param_name or /node_name param_name (e.g. /turtlesim background_r)"})

    extra_names = list(getattr(args, 'extra_names', []) or [])

    try:
        from rcl_interfaces.srv import GetParameters
        with ros2_context():
            node = ROS2CLI()
            node_name, param_name = full_name.split(':', 1)
            node_name = _norm_node(node_name)
            all_param_names = [param_name] + extra_names
            request = GetParameters.Request()
            request.names = all_param_names
            result, err = _call_service(
                node, GetParameters, f"{node_name}/get_parameters",
                request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        values = result.values if result.values else []

        if not extra_names:
            # Single-key: preserve original output format for backward compatibility.
            if values and values[0].type != 0:
                py_val = _param_value_to_python(values[0])
                output({"name": full_name, "value": str(py_val) if py_val is not None else "", "exists": True})
            else:
                output({"name": full_name, "value": "", "exists": False})
        else:
            # Multi-key: return a dict of {param_name: {value, exists}}.
            params_out = {}
            for pname, pval in zip(all_param_names, values):
                if pval.type != 0:
                    py_val = _param_value_to_python(pval)
                    params_out[pname] = {"value": str(py_val) if py_val is not None else "", "exists": True}
                else:
                    params_out[pname] = {"value": "", "exists": False}
            output({"node": node_name, "parameters": params_out, "count": len(params_out)})
    except Exception as e:
        output({"error": str(e)})


def _coerce_param_value(value_str, force_type=None):
    """Build a ParameterValue from *value_str*.

    If *force_type* is one of ``'bool'``, ``'int'``, ``'float'``, ``'str'``
    (from the ``--type`` flag, Lyrical Luth YAML annotation style), that type
    is used directly.  Otherwise the existing heuristic inference applies so
    that all pre-Lyrical call sites continue to work unchanged.
    """
    pv = ParameterValue()
    try:
        if force_type == 'bool':
            pv.type = 1
            pv.bool_value = value_str.lower() in ('true', '1', 'yes')
        elif force_type == 'int':
            pv.type = 2
            pv.integer_value = int(value_str)
        elif force_type == 'float':
            pv.type = 3
            pv.double_value = float(value_str)
        elif force_type == 'str':
            pv.type = 4
            pv.string_value = value_str
        else:
            # Heuristic inference (all distros)
            if value_str.lower() in ('true', 'false'):
                pv.type = 1
                pv.bool_value = value_str.lower() == 'true'
            elif '.' in value_str:
                pv.type = 3
                pv.double_value = float(value_str)
            else:
                try:
                    pv.type = 2
                    pv.integer_value = int(value_str)
                except Exception:
                    pv.type = 4
                    pv.string_value = value_str
    except Exception:
        pv.type = 4
        pv.string_value = value_str
    return pv


def cmd_params_set(args):
    """Set one or more parameters on a node.

    Accepts the existing single-parameter formats unchanged::

        params set /turtlesim:background_r 255
        params set /turtlesim background_r 255

    Lyrical Luth extensions:

    *Multiple pairs* — set several parameters in one call::

        params set /turtlesim background_r 255 background_g 128 background_b 64

    *Explicit type override* (``--type``) — mirrors YAML ``!!`` annotations::

        params set /turtlesim use_sim_time true --type bool
        params set /turtlesim some_id 007 --type str
    """
    if getattr(args, 'extra_value', None) is not None:
        full_name = args.name.rstrip(':') + ':' + args.value
        first_value_str = args.extra_value
    else:
        full_name = args.name
        first_value_str = args.value
    if ':' not in full_name or not full_name.split(':', 1)[1]:
        return output({"error": "Use format /node_name:param_name value or /node_name param_name value (e.g. /turtlesim background_r 255)"})

    node_name, first_param = full_name.split(':', 1)
    node_name = _norm_node(node_name)
    force_type = getattr(args, 'force_type', None)

    # Build first pair
    pairs = [(first_param, first_value_str)]

    # Additional pairs from Lyrical multi-pair extension: rest = [p2, v2, p3, v3, ...]
    rest = list(getattr(args, 'rest', None) or [])
    if rest:
        if len(rest) % 2 != 0:
            return output({"error": "Extra param-value pairs must be even: p2 v2 p3 v3 ..."})
        for i in range(0, len(rest), 2):
            pairs.append((rest[i], rest[i + 1]))

    try:
        from rcl_interfaces.srv import SetParameters
        with ros2_context():
            node = ROS2CLI()
            request = SetParameters.Request()
            params_list = []
            for pname, pval_str in pairs:
                p = Parameter()
                p.name = pname
                p.value = _coerce_param_value(pval_str, force_type)
                params_list.append(p)
            request.parameters = params_list

            result, err = _call_service(
                node, SetParameters, f"{node_name}/set_parameters",
                request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)

        # Single param — preserve original compact output format
        if len(pairs) == 1:
            pname, pval_str = pairs[0]
            if result.results and result.results[0].successful:
                output({"name": f"{node_name}:{pname}", "value": pval_str, "success": True})
            else:
                reason = result.results[0].reason if result.results else ""
                reason_lc = reason.lower()
                if re.search(r'\b(read[- ]?only|readonly)\b', reason_lc):
                    output({"name": f"{node_name}:{pname}", "value": pval_str, "success": False,
                            "error": "Parameter is read-only and cannot be changed at runtime",
                            "read_only": True})
                else:
                    output({"name": f"{node_name}:{pname}", "value": pval_str, "success": False,
                            "error": reason or "Parameter rejected by node"})
        else:
            # Multi-param — return structured results list
            results_out = []
            for (pname, pval_str), r in zip(pairs, result.results or []):
                entry = {"name": pname, "value": pval_str, "success": r.successful}
                if not r.successful:
                    reason = r.reason.lower()
                    if re.search(r'\b(read[- ]?only|readonly)\b', reason):
                        entry["error"] = "Parameter is read-only"
                        entry["read_only"] = True
                    else:
                        entry["error"] = r.reason or "Parameter rejected by node"
                results_out.append(entry)
            output({"node": node_name, "results": results_out, "count": len(pairs)})
    except Exception as e:
        output({"error": str(e)})


def cmd_params_describe(args):
    """Get the descriptor of a parameter."""
    if getattr(args, 'param_name', None):
        full_name = args.name.rstrip(':') + ':' + args.param_name
    else:
        full_name = args.name
    if ':' not in full_name or not full_name.split(':', 1)[1]:
        return output({"error": "Use format /node_name:param_name or /node_name param_name"})

    try:
        from rcl_interfaces.srv import DescribeParameters
        with ros2_context():
            node = ROS2CLI()
            node_name, param_name = full_name.split(':', 1)
            node_name = _norm_node(node_name)
            request = DescribeParameters.Request()
            request.names = [param_name]
            result, err = _call_service(
                node, DescribeParameters, f"{node_name}/describe_parameters",
                request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        if not result.descriptors:
            return output({"error": f"Parameter '{param_name}' not found on {node_name}"})
        d = result.descriptors[0]
        out = {
            "name": full_name,
            "type": d.type,
            "description": d.description,
            "read_only": d.read_only,
            "dynamic_typing": d.dynamic_typing,
            "additional_constraints": d.additional_constraints,
        }
        if d.floating_point_range:
            r = d.floating_point_range[0]
            out["floating_point_range"] = {"from_value": r.from_value,
                                           "to_value": r.to_value, "step": r.step}
        if d.integer_range:
            r = d.integer_range[0]
            out["integer_range"] = {"from_value": r.from_value,
                                    "to_value": r.to_value, "step": r.step}
        output(out)
    except Exception as e:
        output({"error": str(e)})


def _dump_params(node, node_name, timeout, retries=1):
    """Fetch all parameters for node_name using the provided rclpy node.

    Returns a {param_name: value} dict on success, or None after calling output({"error": ...}).
    """
    try:
        from rcl_interfaces.srv import ListParameters, GetParameters

        list_result, err = _call_service(
            node, ListParameters, f"{node_name}/list_parameters",
            ListParameters.Request(), timeout, retries,
        )
        if err:
            output(err)
            return None

        names = list_result.result.names if list_result.result else []
        if not names:
            return {}

        get_req = GetParameters.Request()
        get_req.names = list(names)
        get_result, err = _call_service(
            node, GetParameters, f"{node_name}/get_parameters",
            get_req, timeout, retries,
        )
        if err:
            output(err)
            return None

        values = get_result.values or []
        return {n: _param_value_to_python(v) for n, v in zip(names, values)}
    except Exception as e:
        output({"error": str(e)})
        return None


def cmd_params_dump(args):
    """Export all parameters of a node as a JSON dict."""
    node_name = _norm_node(args.node)
    with ros2_context():
        node = ROS2CLI()
        result = _dump_params(node, node_name, args.timeout, getattr(args, 'retries', 1))
    if result is not None:
        output({"node": node_name, "parameters": result, "count": len(result)})


def cmd_params_load(args):
    """Load parameters onto a node from a JSON or YAML string or file.

    Lyrical Luth: YAML files (``.yaml``/``.yml``) are now fully supported,
    including ``!!str``, ``!!bool``, ``!!int``, ``!!float`` type annotations
    that override YAML's automatic type inference.  JSON files and inline JSON
    strings continue to work unchanged on all distros.
    """
    node_name = _norm_node(args.node)

    raw = args.params
    try:
        import pathlib
        p = pathlib.Path(raw)
        if p.exists():
            if p.suffix.lower() in ('.yaml', '.yml'):
                import yaml
                with open(raw) as f:
                    data = yaml.safe_load(f)
            else:
                with open(raw) as f:
                    data = json.load(f)
        else:
            # Inline string: try JSON first, fall back to YAML
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                import yaml
                data = yaml.safe_load(raw)
    except Exception as e:
        return output({"error": f"Invalid JSON/YAML or file not found: {e}"})

    if not isinstance(data, dict):
        return output({"error": "JSON must be a flat object {param_name: value, ...}"})

    try:
        from rcl_interfaces.srv import SetParameters
        with ros2_context():
            node = ROS2CLI()
            request = SetParameters.Request()
            params = []
            for pname, pvalue in data.items():
                p = Parameter()
                p.name = pname
                p.value = _infer_param_value(pvalue)
                params.append(p)
            request.parameters = params
            result, err = _call_service(
                node, SetParameters, f"{node_name}/set_parameters",
                request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        results_raw = result.results or []
        results = []
        for pname, r in zip(data.keys(), results_raw):
            entry = {"name": pname, "success": r.successful}
            if not r.successful and r.reason:
                entry["reason"] = r.reason
            results.append(entry)
        output({"node": node_name, "results": results})
    except Exception as e:
        output({"error": str(e)})


def cmd_params_delete(args):
    """Delete one or more parameters from a node."""
    if getattr(args, 'param_name', None):
        full_name = args.name.rstrip(':') + ':' + args.param_name
    else:
        full_name = args.name
    if ':' not in full_name or not full_name.split(':', 1)[1]:
        return output({"error": "Use format /node_name:param_name or /node_name param_name"})

    node_name, param_name = full_name.split(':', 1)
    node_name = _norm_node(node_name)
    param_names = [param_name] + (list(args.extra_names) if getattr(args, 'extra_names', None) else [])

    try:
        from rcl_interfaces.srv import SetParameters
        from rcl_interfaces.msg import Parameter as _Param, ParameterValue as _PV
        with ros2_context():
            node = ROS2CLI()
            request = SetParameters.Request()
            params = []
            for pname in param_names:
                p = _Param()
                p.name = pname
                p.value = _PV()  # type=0 == PARAMETER_NOT_SET
                params.append(p)
            request.parameters = params
            result, err = _call_service(
                node, SetParameters, f"{node_name}/set_parameters",
                request, args.timeout, getattr(args, 'retries', 1),
            )
        if err:
            return output(err)
        results_raw = result.results or []
        results = []
        for pname, r in zip(param_names, results_raw):
            entry = {"name": pname, "success": r.successful}
            if not r.successful:
                entry["error"] = r.reason or "Node rejected deletion (parameter may be read-only or undeclaring is not allowed)"
            results.append(entry)
        output({"node": node_name, "results": results, "count": len(param_names)})
    except Exception as e:
        output({"error": str(e)})


# ---------------------------------------------------------------------------
# Parameter preset commands
# Presets are stored as plain {param_name: value} JSON files under
# .presets/{preset_name}.json  (beside the scripts/ directory,
# created automatically — same pattern as the .artifacts/ folder)
# ---------------------------------------------------------------------------

def _presets_base():
    """Return the absolute path to the .presets/ directory, creating it if needed."""
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.presets'))
    os.makedirs(base, exist_ok=True)
    return base


def cmd_params_preset_save(args):
    """Save the current parameters of a node as a named preset."""
    node_name = _norm_node(args.node)
    with ros2_context():
        node = ROS2CLI()
        params_dict = _dump_params(node, node_name, args.timeout, getattr(args, 'retries', 1))
    if params_dict is None:
        return  # _dump_params already called output({"error": ...})

    preset_path = os.path.join(_presets_base(), f"{args.preset}.json")
    with open(preset_path, 'w') as f:
        json.dump(params_dict, f, indent=2)
    output({"node": node_name, "preset": args.preset, "path": preset_path,
            "count": len(params_dict)})


def cmd_params_preset_load(args):
    """Restore a named preset onto a node."""
    node_name = _norm_node(args.node)
    preset_path = os.path.join(_presets_base(), f"{args.preset}.json")
    if not os.path.exists(preset_path):
        return output({"error": f"Preset '{args.preset}' not found", "path": preset_path})
    load_args = types.SimpleNamespace(
        node=node_name, params=preset_path, timeout=args.timeout,
        retries=getattr(args, 'retries', 1),
    )
    cmd_params_load(load_args)


def cmd_params_preset_list(args):
    """List all saved presets."""
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.presets'))
    presets = []
    if os.path.isdir(base_dir):
        for fname in sorted(os.listdir(base_dir)):
            if fname.endswith('.json'):
                presets.append({"preset": fname[:-5], "path": os.path.join(base_dir, fname)})
    output({"presets": presets, "count": len(presets)})


def cmd_params_preset_delete(args):
    """Delete a saved preset file."""
    preset_path = os.path.join(_presets_base(), f"{args.preset}.json")
    if not os.path.exists(preset_path):
        return output({"error": f"Preset '{args.preset}' not found"})
    os.remove(preset_path)
    output({"preset": args.preset, "deleted": True})


def cmd_params_find(args):
    """Search all running nodes (or one specific node) for parameters matching a pattern."""
    pattern = args.pattern
    node_filter = getattr(args, 'node', None)
    timeout = getattr(args, 'timeout', 10.0)

    if node_filter and not node_filter.startswith('/'):
        node_filter = '/' + node_filter

    match_all = pattern.lower() in ('all', '*')

    def _param_matches(name):
        return match_all or pattern.lower() in name.lower()

    try:
        from rcl_interfaces.srv import ListParameters, GetParameters
        with ros2_context():
            node = ROS2CLI()

            if node_filter:
                nodes_to_search = [node_filter]
            else:
                node_info = node.get_node_names_and_namespaces()
                nodes_to_search = [f"{ns.rstrip('/')}/{n}" for n, ns in node_info]

            matches = []

            for node_name in nodes_to_search:
                list_result, err = _call_service(
                    node, ListParameters, f"{node_name}/list_parameters",
                    ListParameters.Request(), min(timeout, 3.0),
                )
                if err:
                    continue  # Node has no param service — skip silently

                names = list_result.result.names if list_result.result else []
                matching_names = [n for n in names if _param_matches(n)]
                if not matching_names:
                    continue

                get_req = GetParameters.Request()
                get_req.names = list(matching_names)
                get_result, err = _call_service(
                    node, GetParameters, f"{node_name}/get_parameters",
                    get_req, min(timeout, 3.0),
                )
                if err:
                    # Can list but not get — record with unknown values
                    for pname in matching_names:
                        matches.append({"node": node_name, "param": pname,
                                        "full_name": f"{node_name}:{pname}", "value": None})
                    continue

                values = get_result.values or []
                for pname, pval in zip(matching_names, values):
                    py_val = _param_value_to_python(pval)
                    matches.append({
                        "node": node_name,
                        "param": pname,
                        "full_name": f"{node_name}:{pname}",
                        "value": str(py_val) if py_val is not None else None,
                    })

        if not matches:
            return output({"error": f"No parameters matching '{pattern}' found on any node"})

        output({"pattern": pattern, "node_filter": node_filter,
                "matches": matches, "count": len(matches)})
    except Exception as e:
        output({"error": str(e)})


def cmd_params_get_all_nodes(args):
    """Get the value of one parameter from every running node that has it.

    Lyrical Luth-inspired: mirrors ``ros2 param get --all-nodes <param>``.
    Implemented with standard service calls so it works on all ROS 2 distros.

    Output::

        {
            "param": "use_sim_time",
            "nodes": {"/controller_manager": "False", "/robot_state_publisher": "True"},
            "count": 2,
            "not_set": ["/some_node_without_it"]
        }
    """
    param_name = args.param_name
    timeout = getattr(args, 'timeout', 5.0)

    try:
        from rcl_interfaces.srv import ListParameters, GetParameters
        with ros2_context():
            node = ROS2CLI()
            node_info = node.get_node_names_and_namespaces()
            nodes_to_search = [
                f"{ns.rstrip('/')}/{n}" if not ns.endswith('/') else f"{ns}{n}"
                for n, ns in node_info
            ]

            found = {}
            not_set = []
            errors = []
            per_node_timeout = min(timeout, 3.0)

            for node_name in nodes_to_search:
                list_result, err = _call_service(
                    node, ListParameters, f"{node_name}/list_parameters",
                    ListParameters.Request(), per_node_timeout,
                )
                if err:
                    continue  # node has no param service — skip silently

                names = list_result.result.names if list_result.result else []
                if param_name not in names:
                    not_set.append(node_name)
                    continue

                get_req = GetParameters.Request()
                get_req.names = [param_name]
                get_result, err = _call_service(
                    node, GetParameters, f"{node_name}/get_parameters",
                    get_req, per_node_timeout,
                )
                if err:
                    errors.append(node_name)
                    continue

                values = get_result.values or []
                if values and values[0].type != 0:
                    py_val = _param_value_to_python(values[0])
                    found[node_name] = str(py_val) if py_val is not None else ""
                else:
                    not_set.append(node_name)

        if not found and not errors:
            return output({
                "error": f"Parameter '{param_name}' not found on any running node",
                "searched": len(nodes_to_search),
            })

        out = {
            "param": param_name,
            "nodes": found,
            "count": len(found),
            "not_set": not_set,
        }
        if errors:
            out["errors"] = errors
        output(out)
    except Exception as e:
        output({"error": str(e)})


def cmd_params_exists(args):
    """Check whether a parameter exists on a node without raising an error.

    Accepts the same '/node:param' format as params get.
    Returns {exists: true/false, node, param, name} or {error: ...} on
    service failure (node down, timeout, bad format).
    """
    name = args.name
    if ":" not in name or not name.split(":", 1)[1]:
        return output({
            "error": "Use format /node_name:param_name "
                     "(e.g. /turtlesim:background_r)"
        })

    try:
        from rcl_interfaces.srv import GetParameters
        with ros2_context():
            node_rclpy = ROS2CLI()
            node_name, param_name = name.split(":", 1)
            node_name = _norm_node(node_name)

            result, err = _call_service(
                node_rclpy,
                GetParameters,
                f"{node_name}/get_parameters",
                GetParameters.Request(names=[param_name]),
                timeout=args.timeout,
            )

        if err:
            return output(err)

        # ParameterValue.type == 0 means NOT_SET (parameter does not exist)
        exists = bool(result.values and result.values[0].type != 0)
        output({
            "exists": exists,
            "node": node_name,
            "param": param_name,
            "name": name,
        })

    except Exception as e:
        output({"error": str(e)})


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

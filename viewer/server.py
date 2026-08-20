"""Local browser viewer for tau2 tasks, domains, and simulation results."""

from __future__ import annotations

import argparse
import ast
import base64
import binascii
import hashlib
import json
import threading
import webbrowser
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from viewer.workbench import build_workbench
except ModuleNotFoundError:  # Direct `python viewer/server.py` execution.
    from workbench import build_workbench


VIEWER_DIR = Path(__file__).resolve().parent
REPO_ROOT = VIEWER_DIR.parent
STATIC_DIR = VIEWER_DIR / "static"
DOMAIN_DIR = REPO_ROOT / "data" / "tau2" / "domains" / "airline"
RESULTS_DIR = REPO_ROOT / "data" / "simulations"
TOOLS_FILE = REPO_ROOT / "src" / "tau2" / "domains" / "airline" / "tools.py"
MODEL_FILE = REPO_ROOT / "src" / "tau2" / "domains" / "airline" / "data_model.py"
ENVIRONMENT_FILE = REPO_ROOT / "src" / "tau2" / "domains" / "airline" / "environment.py"
WORKBENCH_ANNOTATIONS_FILE = VIEWER_DIR / "workbench_annotations.json"

app = FastAPI(
    title="Tau2 Inspector",
    description="A local, read-only browser for tau2 benchmark artifacts.",
    docs_url="/api/docs",
    redoc_url=None,
)
app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")

_json_cache: dict[Path, tuple[tuple[int, int], Any]] = {}


def _read_json(path: Path) -> Any:
    """Read JSON while avoiding repeat parsing when the file is unchanged."""
    stat = path.stat()
    stamp = (stat.st_mtime_ns, stat.st_size)
    cached = _json_cache.get(path)
    if cached and cached[0] == stamp:
        return cached[1]
    data = json.loads(path.read_text(encoding="utf-8"))
    _json_cache[path] = (stamp, data)
    if len(_json_cache) > 128:
        _json_cache.pop(next(iter(_json_cache)))
    return data


def _watched_paths() -> list[Path]:
    paths = [
        DOMAIN_DIR / "tasks.json",
        DOMAIN_DIR / "split_tasks.json",
        DOMAIN_DIR / "policy.md",
        DOMAIN_DIR / "db.json",
        TOOLS_FILE,
        MODEL_FILE,
        ENVIRONMENT_FILE,
        WORKBENCH_ANNOTATIONS_FILE,
    ]
    if RESULTS_DIR.exists():
        result_files = sorted(RESULTS_DIR.glob("**/results*.json"))
        paths.extend(result_files)
        for result_file in result_files:
            simulations_dir = result_file.parent / "simulations"
            if simulations_dir.is_dir():
                paths.extend(sorted(simulations_dir.glob("*.json")))
    return [path for path in paths if path.exists()]


def _version() -> str:
    """Return a cheap content version based on watched filenames and stats."""
    digest = hashlib.sha1(usedforsecurity=False)
    for path in _watched_paths():
        stat = path.stat()
        digest.update(str(path.relative_to(REPO_ROOT)).encode())
        digest.update(f":{stat.st_mtime_ns}:{stat.st_size}".encode())
    return digest.hexdigest()[:12]


def _task_data() -> list[dict[str, Any]]:
    return _read_json(DOMAIN_DIR / "tasks.json")


def _splits() -> dict[str, list[str]]:
    return _read_json(DOMAIN_DIR / "split_tasks.json")


def _split_lookup() -> dict[str, list[str]]:
    lookup: dict[str, list[str]] = {}
    for name, ids in _splits().items():
        for task_id in ids:
            lookup.setdefault(str(task_id), []).append(name)
    return lookup


def _encode_run_key(relative_path: str, simulation_ref: str) -> str:
    raw = f"{relative_path}|{simulation_ref}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _encode_evaluation_key(relative_path: str) -> str:
    return base64.urlsafe_b64encode(relative_path.encode()).decode().rstrip("=")


def _decode_evaluation_key(evaluation_key: str) -> Path:
    try:
        padded = evaluation_key + "=" * (-len(evaluation_key) % 4)
        relative_path = base64.urlsafe_b64decode(padded).decode()
        path = (RESULTS_DIR / relative_path).resolve()
        path.relative_to(RESULTS_DIR.resolve())
        if not path.is_file() or not path.name.startswith("results"):
            raise ValueError
        return path
    except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
        raise HTTPException(status_code=404, detail="Evaluation not found") from exc


def _decode_run_key(run_key: str) -> tuple[Path, str]:
    try:
        padded = run_key + "=" * (-len(run_key) % 4)
        raw = base64.urlsafe_b64decode(padded).decode()
        relative_path, simulation_ref = raw.rsplit("|", 1)
        path = (RESULTS_DIR / relative_path).resolve()
        path.relative_to(RESULTS_DIR.resolve())
        if not path.is_file() or not path.name.startswith("results"):
            raise ValueError
        if not simulation_ref:
            raise ValueError
        return path, simulation_ref
    except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


def _simulation_summaries(path: Path, data: dict[str, Any]) -> list[dict[str, Any]]:
    """Load lightweight summaries without parsing every directory-format run."""
    simulations_dir = path.parent / "simulations"
    if simulations_dir.is_dir() and data.get("simulation_index") is not None:
        return data.get("simulation_index") or []
    if simulations_dir.is_dir():
        return [
            _read_json(simulation_file)
            for simulation_file in sorted(simulations_dir.glob("*.json"))
        ]
    return data.get("simulations") or []


def _load_selected_simulation(
    path: Path, simulation_ref: str
) -> tuple[dict[str, Any], dict[str, Any], int]:
    """Resolve one stable simulation ID and load only that trajectory."""
    data = _read_json(path)
    simulations_dir = path.parent / "simulations"
    if simulations_dir.is_dir():
        files = {item.stem: item for item in simulations_dir.glob("*.json")}
        simulation_file = files.get(simulation_ref)
        if simulation_file is None:
            raise KeyError(simulation_ref)
        index_ids = [str(item.get("id")) for item in data.get("simulation_index") or []]
        source_order = (
            index_ids.index(simulation_ref) if simulation_ref in index_ids else 0
        )
        return data, _read_json(simulation_file), source_order

    simulations = data.get("simulations") or []
    for index, simulation in enumerate(simulations):
        reference = str(simulation.get("id") or f"position-{index}")
        if reference == simulation_ref:
            return data, simulation, index
    raise KeyError(simulation_ref)


def _messages_for_simulation(simulation: dict[str, Any]) -> list[dict[str, Any]]:
    """Return stored messages or flatten full-duplex tick events."""
    stored = simulation.get("messages")
    if stored is not None:
        return stored
    messages: list[dict[str, Any]] = []
    for tick in simulation.get("ticks") or []:
        tick_id = tick.get("tick_id")
        timestamp = tick.get("timestamp")
        agent_chunk = tick.get("agent_chunk")
        agent_calls = tick.get("agent_tool_calls") or []
        if agent_chunk or agent_calls:
            message = dict(agent_chunk or {})
            message.update(
                {
                    "role": "assistant",
                    "tool_calls": agent_calls or None,
                    "timestamp": message.get("timestamp") or timestamp,
                    "tick_id": tick_id,
                }
            )
            messages.append(message)
        for result in tick.get("agent_tool_results") or []:
            messages.append({**result, "tick_id": tick_id})

        user_chunk = tick.get("user_chunk")
        user_calls = tick.get("user_tool_calls") or []
        if user_chunk or user_calls:
            message = dict(user_chunk or {})
            message.update(
                {
                    "role": "user",
                    "tool_calls": user_calls or None,
                    "timestamp": message.get("timestamp") or timestamp,
                    "tick_id": tick_id,
                }
            )
            messages.append(message)
        for result in tick.get("user_tool_results") or []:
            messages.append({**result, "tick_id": tick_id})
    messages.sort(key=lambda message: message.get("timestamp") or "")
    for index, message in enumerate(messages):
        if message.get("turn_idx") is None:
            message["turn_idx"] = index
    return messages


def _purpose_for_task(data: dict[str, Any], task_id: str) -> str:
    for task in data.get("tasks") or []:
        if str(task.get("id")) == task_id:
            return (task.get("description") or {}).get("purpose") or "Untitled task"
    return "Untitled task"


def _message_tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    calls = message.get("tool_calls")
    return calls if isinstance(calls, list) else []


def _run_summaries() -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    if not RESULTS_DIR.exists():
        return runs
    for path in sorted(RESULTS_DIR.glob("**/results*.json"), reverse=True):
        try:
            data = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        info = data.get("info") or {}
        agent_info = info.get("agent_info") or {}
        user_info = info.get("user_info") or {}
        environment_info = info.get("environment_info") or {}
        if environment_info.get("domain_name") != "airline":
            continue
        relative = str(path.relative_to(RESULTS_DIR))
        simulations = _simulation_summaries(path, data)
        for index, simulation in enumerate(simulations):
            is_lightweight = "reward_info" not in simulation
            messages = [] if is_lightweight else _messages_for_simulation(simulation)
            reward_info = simulation.get("reward_info") or {}
            reward = (
                simulation.get("reward")
                if is_lightweight
                else reward_info.get("reward")
            )
            task_id = str(simulation.get("task_id") or "unknown")
            simulation_ref = str(simulation.get("id") or f"position-{index}")
            runs.append(
                {
                    "key": _encode_run_key(relative, simulation_ref),
                    "file": relative,
                    "folder": str(path.parent.relative_to(RESULTS_DIR)),
                    "index": index,
                    "source_order": index,
                    "simulation_id": simulation.get("id"),
                    "task_id": task_id,
                    "purpose": _purpose_for_task(data, task_id),
                    "timestamp": simulation.get("timestamp") or data.get("timestamp"),
                    "duration": simulation.get("duration"),
                    "termination_reason": simulation.get("termination_reason"),
                    "reward": reward,
                    "passed": reward == 1,
                    "reward_basis": reward_info.get("reward_basis") or [],
                    "reward_breakdown": reward_info.get("reward_breakdown") or {},
                    "turns": None if is_lightweight else len(messages),
                    "tool_calls": None
                    if is_lightweight
                    else sum(len(_message_tool_calls(m)) for m in messages),
                    "agent_cost": simulation.get("agent_cost"),
                    "user_cost": simulation.get("user_cost"),
                    "total_cost": (simulation.get("agent_cost") or 0)
                    + (simulation.get("user_cost") or 0),
                    "agent_model": agent_info.get("llm"),
                    "user_model": user_info.get("llm"),
                    "agent_implementation": agent_info.get("implementation"),
                    "domain": environment_info.get("domain_name") or "unknown",
                    "trial": simulation.get("trial"),
                    "mode": simulation.get("mode"),
                    "has_error": bool((simulation.get("info") or {}).get("error"))
                    or simulation.get("termination_reason") == "infrastructure_error",
                }
            )
    runs.sort(key=lambda run: run.get("timestamp") or "", reverse=True)
    return runs


def _simulation_reward(simulation: dict[str, Any]) -> Any:
    if "reward_info" in simulation:
        return (simulation.get("reward_info") or {}).get("reward")
    return simulation.get("reward")


def _evaluation_summaries() -> list[dict[str, Any]]:
    """Return one compact row per saved airline evaluation artifact."""
    evaluations: list[dict[str, Any]] = []
    if not RESULTS_DIR.exists():
        return evaluations
    catalog_size = len(_task_data())
    for path in sorted(RESULTS_DIR.glob("**/results*.json")):
        try:
            data = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        info = data.get("info") or {}
        environment_info = info.get("environment_info") or {}
        if environment_info.get("domain_name") != "airline":
            continue
        simulations = _simulation_summaries(path, data)
        rewards = [_simulation_reward(simulation) for simulation in simulations]
        evaluated = [reward for reward in rewards if reward is not None]
        task_ids = {
            str(simulation.get("task_id"))
            for simulation in simulations
            if simulation.get("task_id") is not None
        }
        relative = str(path.relative_to(RESULTS_DIR))
        agent_info = info.get("agent_info") or {}
        failures = sum(reward != 1 for reward in evaluated)
        evaluations.append(
            {
                "key": _encode_evaluation_key(relative),
                "file": relative,
                "folder": str(path.parent.relative_to(RESULTS_DIR)),
                "timestamp": data.get("timestamp")
                or max(
                    (simulation.get("timestamp") or "" for simulation in simulations),
                    default="",
                ),
                "agent_model": agent_info.get("llm"),
                "reasoning_effort": (agent_info.get("llm_args") or {}).get(
                    "reasoning_effort"
                ),
                "simulation_count": len(simulations),
                "evaluated_count": len(evaluated),
                "passed_count": sum(reward == 1 for reward in evaluated),
                "failed_count": failures,
                "error_count": sum(
                    simulation.get("termination_reason") == "infrastructure_error"
                    or bool((simulation.get("info") or {}).get("error"))
                    for simulation in simulations
                ),
                "success_rate": (
                    sum(reward == 1 for reward in evaluated) / len(evaluated)
                    if evaluated
                    else None
                ),
                "unique_task_count": len(task_ids),
                "complete_catalog": len(task_ids) >= catalog_size,
            }
        )
    evaluations.sort(
        key=lambda item: (
            item["complete_catalog"],
            item["unique_task_count"],
            item["simulation_count"],
            item["timestamp"] or "",
        ),
        reverse=True,
    )
    return evaluations


def _full_evaluation_simulations(
    path: Path, data: dict[str, Any]
) -> list[dict[str, Any]]:
    simulations_dir = path.parent / "simulations"
    if not simulations_dir.is_dir():
        return data.get("simulations") or []
    simulations: list[dict[str, Any]] = []
    for summary in _simulation_summaries(path, data):
        simulation_ref = str(summary.get("id") or "")
        if not simulation_ref:
            continue
        try:
            _, simulation, _ = _load_selected_simulation(path, simulation_ref)
        except (OSError, json.JSONDecodeError, KeyError):
            continue
        simulations.append(simulation)
    return simulations


def _evaluation_annotations(relative_path: str) -> dict[str, Any]:
    if not WORKBENCH_ANNOTATIONS_FILE.exists():
        return {}
    try:
        annotations = _read_json(WORKBENCH_ANNOTATIONS_FILE)
    except (OSError, json.JSONDecodeError):
        return {}
    return (annotations.get("batches") or {}).get(relative_path) or {}


def _workbench_detail(evaluation_key: str | None = None) -> dict[str, Any]:
    evaluations = _evaluation_summaries()
    if not evaluations:
        raise HTTPException(status_code=404, detail="No airline evaluations found")
    path = (
        _decode_evaluation_key(evaluation_key)
        if evaluation_key
        else _decode_evaluation_key(evaluations[0]["key"])
    )
    relative = str(path.relative_to(RESULTS_DIR.resolve()))
    selected = next(
        (evaluation for evaluation in evaluations if evaluation["file"] == relative),
        None,
    )
    if selected is None:
        raise HTTPException(status_code=404, detail="Evaluation not found")
    try:
        data = _read_json(path)
        simulations = _full_evaluation_simulations(path, data)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=503, detail="Evaluation is still being written"
        ) from exc
    tool_types = {tool["name"]: tool["type"] for tool in _tool_definitions()}
    detail = build_workbench(
        data,
        simulations,
        batch=selected,
        tool_types=tool_types,
        run_key_for=lambda simulation, index: _encode_run_key(
            relative, str(simulation.get("id") or f"position-{index}")
        ),
        annotations=_evaluation_annotations(relative),
    )
    detail["evaluations"] = evaluations
    return detail


def _decorator_tool_type(decorator: ast.expr) -> str | None:
    if not isinstance(decorator, ast.Call):
        return None
    if not isinstance(decorator.func, ast.Name) or decorator.func.id != "is_tool":
        return None
    if not decorator.args:
        return None
    argument = decorator.args[0]
    if isinstance(argument, ast.Attribute):
        return argument.attr.lower()
    return ast.unparse(argument).lower()


def _tool_definitions() -> list[dict[str, Any]]:
    source = TOOLS_FILE.read_text(encoding="utf-8")
    tree = ast.parse(source)
    tools: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        tool_type = next(
            (
                parsed
                for decorator in node.decorator_list
                if (parsed := _decorator_tool_type(decorator)) is not None
            ),
            None,
        )
        if tool_type is None:
            continue
        parameters: list[dict[str, Any]] = []
        positional = node.args.posonlyargs + node.args.args
        defaults: list[ast.expr | None] = [None] * (
            len(positional) - len(node.args.defaults)
        ) + list(node.args.defaults)
        for argument, default in zip(positional, defaults):
            if argument.arg == "self":
                continue
            parameters.append(
                {
                    "name": argument.arg,
                    "type": ast.unparse(argument.annotation)
                    if argument.annotation
                    else "Any",
                    "required": default is None,
                    "default": ast.unparse(default) if default is not None else None,
                }
            )
        for argument, default in zip(node.args.kwonlyargs, node.args.kw_defaults):
            parameters.append(
                {
                    "name": argument.arg,
                    "type": ast.unparse(argument.annotation)
                    if argument.annotation
                    else "Any",
                    "required": default is None,
                    "default": ast.unparse(default) if default is not None else None,
                }
            )
        signature = ", ".join(
            f"{param['name']}: {param['type']}"
            + ("" if param["required"] else f" = {param['default']}")
            for param in parameters
        )
        tools.append(
            {
                "name": node.name,
                "type": tool_type,
                "signature": f"{node.name}({signature})",
                "parameters": parameters,
                "returns": ast.unparse(node.returns) if node.returns else "Any",
                "description": ast.get_docstring(node) or "",
                "line": node.lineno,
            }
        )
    runtime = _runtime_tool_definitions(
        TOOLS_FILE.stat().st_mtime_ns,
        MODEL_FILE.stat().st_mtime_ns,
        ENVIRONMENT_FILE.stat().st_mtime_ns,
    )
    for tool in tools:
        tool.update(runtime.get(tool["name"], {}))
    return sorted(tools, key=lambda tool: (tool["type"], tool["name"]))


@lru_cache(maxsize=4)
def _runtime_tool_definitions(
    source_stamp: int, model_stamp: int, environment_stamp: int
) -> dict[str, dict[str, Any]]:
    """Load Tau2's generated schemas, with AST data retained as a fallback."""
    del source_stamp, model_stamp, environment_stamp
    try:
        from tau2.domains.airline.environment import get_environment

        environment = get_environment()
        runtime: dict[str, dict[str, Any]] = {}
        for name, tool in environment.tools.get_tools().items():
            schema = tool.params.model_json_schema()
            parameters = []
            required = set(schema.get("required") or [])
            for parameter_name, definition in (schema.get("properties") or {}).items():
                parameter_type = definition.get("type")
                if not parameter_type and "$ref" in definition:
                    parameter_type = definition["$ref"].rsplit("/", 1)[-1]
                if not parameter_type and "anyOf" in definition:
                    parameter_type = " | ".join(
                        item.get("type") or item.get("$ref", "Any").rsplit("/", 1)[-1]
                        for item in definition["anyOf"]
                    )
                parameters.append(
                    {
                        "name": parameter_name,
                        "type": parameter_type or definition.get("title") or "Any",
                        "required": parameter_name in required,
                        "default": definition.get("default"),
                        "description": definition.get("description"),
                    }
                )
            runtime[name] = {
                "type": environment.tools.tool_type(name).value,
                "mutates_state": environment.tools.tool_mutates_state(name),
                "description": tool._get_description(),
                "parameters": parameters,
                "parameter_schema": schema,
                "return_schema": tool.returns.model_json_schema(),
            }
        return runtime
    except Exception:
        return {}


def _display_content(content: Any) -> str:
    if not isinstance(content, str):
        return json.dumps(content, ensure_ascii=False, indent=2)
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return content
    if isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
        return parsed["message"]
    return content


def _raw_summary(raw_data: Any) -> dict[str, Any] | None:
    if not isinstance(raw_data, dict):
        return None
    wanted = [
        "id",
        "object",
        "model",
        "status",
        "error",
        "incomplete_details",
        "reasoning",
        "usage",
        "service_tier",
        "created_at",
        "completed_at",
    ]
    return {key: raw_data.get(key) for key in wanted if raw_data.get(key) is not None}


def _normalise_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalised: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        item = {key: value for key, value in message.items() if key != "raw_data"}
        item["index"] = index
        item["display_content"] = _display_content(message.get("content") or "")
        item["raw_summary"] = _raw_summary(message.get("raw_data"))
        normalised.append(item)
    return normalised


def _tool_trajectory(
    messages: list[dict[str, Any]], tool_types: dict[str, str]
) -> list[dict[str, Any]]:
    results = {
        (message.get("requestor"), message.get("id")): message
        for message in messages
        if message.get("role") == "tool" and message.get("id")
    }
    trajectory: list[dict[str, Any]] = []
    for message in messages:
        for call in _message_tool_calls(message):
            result = results.get((call.get("requestor"), call.get("id"))) or {}
            trajectory.append(
                {
                    "id": call.get("id"),
                    "name": call.get("name"),
                    "type": tool_types.get(call.get("name"), "unknown"),
                    "arguments": call.get("arguments") or {},
                    "requestor": call.get("requestor"),
                    "turn": message.get("turn_idx"),
                    "result_turn": result.get("turn_idx"),
                    "result": result.get("content"),
                    "display_result": _display_content(result.get("content") or ""),
                    "error": result.get("error"),
                    "latency": message.get("generation_time_seconds"),
                }
            )
    return trajectory


def _behavior_summary(
    simulation: dict[str, Any],
    messages: list[dict[str, Any]],
    trajectory: list[dict[str, Any]],
) -> dict[str, Any]:
    role_counts: dict[str, int] = {}
    prompt_tokens = 0
    completion_tokens = 0
    generation_times: list[float] = []
    for message in messages:
        role = str(message.get("role") or "unknown")
        role_counts[role] = role_counts.get(role, 0) + 1
        usage = message.get("usage") or {}
        prompt_tokens += usage.get("prompt_tokens") or 0
        completion_tokens += usage.get("completion_tokens") or 0
        if isinstance(message.get("generation_time_seconds"), (int, float)):
            generation_times.append(message["generation_time_seconds"])
    return {
        "role_counts": role_counts,
        "tool_call_count": len(trajectory),
        "unique_tools": sorted({item["name"] for item in trajectory if item["name"]}),
        "tool_errors": sum(bool(item.get("error")) for item in trajectory),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "average_generation_seconds": (
            sum(generation_times) / len(generation_times) if generation_times else None
        ),
        "agent_cost": simulation.get("agent_cost"),
        "user_cost": simulation.get("user_cost"),
        "total_cost": (simulation.get("agent_cost") or 0)
        + (simulation.get("user_cost") or 0),
        "termination_reason": simulation.get("termination_reason"),
    }


def _run_detail(run_key: str, include_raw: bool = False) -> dict[str, Any]:
    path, simulation_ref = _decode_run_key(run_key)
    try:
        data, simulation, source_order = _load_selected_simulation(path, simulation_ref)
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc
    task_id = str(simulation.get("task_id") or "")
    task = next(
        (item for item in data.get("tasks") or [] if str(item.get("id")) == task_id),
        next((item for item in _task_data() if str(item.get("id")) == task_id), None),
    )
    messages = _messages_for_simulation(simulation)
    tool_types = {tool["name"]: tool["type"] for tool in _tool_definitions()}
    trajectory = _tool_trajectory(messages, tool_types)
    detail = {
        "key": run_key,
        "file": str(path.relative_to(RESULTS_DIR.resolve())),
        "run_timestamp": data.get("timestamp"),
        "run_info": data.get("info") or {},
        "task": task,
        "simulation": {
            key: value
            for key, value in simulation.items()
            if key not in {"messages", "ticks", "policy", "raw_data"}
        },
        "messages": _normalise_messages(messages),
        "ticks": simulation.get("ticks"),
        "trajectory": trajectory,
        "behavior": _behavior_summary(simulation, messages, trajectory),
        "policy": simulation.get("policy")
        or (data.get("info") or {}).get("environment_info", {}).get("policy"),
    }
    if include_raw:
        detail["raw"] = {
            "run": data,
            "selected_simulation": simulation,
            "source_order": source_order,
        }
    return detail


@app.middleware("http")
async def no_cache(request: Any, call_next: Any) -> Any:
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "base-uri 'none'; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "form-action 'none'; "
        "frame-ancestors 'none'; "
        "img-src 'self' data:; "
        "object-src 'none'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'"
    )
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), geolocation=(), microphone=()"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "repo": str(REPO_ROOT), "version": _version()}


@app.get("/api/version")
def version() -> dict[str, str]:
    return {"version": _version()}


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    tasks = _task_data()
    split_lookup = _split_lookup()
    runs = _run_summaries()
    tools = _tool_definitions()
    evaluations = _evaluation_summaries()
    db = _read_json(DOMAIN_DIR / "db.json")
    successful = sum(run["reward"] == 1 for run in runs)
    evaluated = sum(run["reward"] is not None for run in runs)
    return {
        "version": _version(),
        "domain": "airline",
        "repo": str(REPO_ROOT),
        "tasks": [
            {
                "id": str(task.get("id")),
                "purpose": (task.get("description") or {}).get("purpose"),
                "splits": split_lookup.get(str(task.get("id")), []),
                "reward_basis": (task.get("evaluation_criteria") or {}).get(
                    "reward_basis", []
                ),
                "reference_actions": len(
                    (task.get("evaluation_criteria") or {}).get("actions") or []
                ),
                "assertions": len(
                    (task.get("evaluation_criteria") or {}).get("nl_assertions") or []
                ),
            }
            for task in tasks
        ],
        "splits": {name: len(ids) for name, ids in _splits().items()},
        "runs": runs,
        "evaluations": evaluations,
        "tools": tools,
        "database": {name: len(records) for name, records in db.items()},
        "stats": {
            "task_count": len(tasks),
            "simulation_count": len(runs),
            "result_file_count": len({run["file"] for run in runs}),
            "evaluated_count": evaluated,
            "successful_count": successful,
            "success_rate": successful / evaluated if evaluated else None,
            "tool_count": len(tools),
            "tool_calls": sum(run["tool_calls"] or 0 for run in runs),
            "total_cost": sum(run["total_cost"] for run in runs),
        },
    }


@app.get("/api/tasks/{task_id}")
def task_detail(task_id: str) -> dict[str, Any]:
    task = next((task for task in _task_data() if str(task.get("id")) == task_id), None)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    matching_runs = [run for run in _run_summaries() if run["task_id"] == task_id]
    return {
        "task": task,
        "splits": _split_lookup().get(task_id, []),
        "runs": matching_runs,
    }


@app.get("/api/policy")
def policy() -> dict[str, Any]:
    text = (DOMAIN_DIR / "policy.md").read_text(encoding="utf-8")
    headings = []
    for line in text.splitlines():
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            headings.append({"level": level, "text": line[level:].strip()})
    return {"markdown": text, "headings": headings}


@app.get("/api/tools")
def tools() -> dict[str, Any]:
    return {
        "tools": _tool_definitions(),
        "source": str(TOOLS_FILE.relative_to(REPO_ROOT)),
    }


@app.get("/api/database/{collection}")
def database_collection(
    collection: str,
    q: str = "",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
) -> dict[str, Any]:
    database = _read_json(DOMAIN_DIR / "db.json")
    if collection not in database:
        raise HTTPException(status_code=404, detail="Database collection not found")
    query = q.strip().casefold()
    records = []
    for record_id, value in database[collection].items():
        if (
            query
            and query not in record_id.casefold()
            and query not in json.dumps(value, ensure_ascii=False).casefold()
        ):
            continue
        records.append({"id": record_id, "value": value})
    total = len(records)
    return {
        "collection": collection,
        "query": q,
        "offset": offset,
        "limit": limit,
        "total": total,
        "items": records[offset : offset + limit],
    }


@app.get("/api/runs/{run_key}")
def run_detail(run_key: str, include_raw: bool = False) -> dict[str, Any]:
    return _run_detail(run_key, include_raw=include_raw)


@app.get("/api/workbench")
def workbench(evaluation_key: str | None = None) -> dict[str, Any]:
    return _workbench_detail(evaluation_key)


@app.exception_handler(json.JSONDecodeError)
def invalid_json_handler(request: Any, exc: json.JSONDecodeError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"detail": f"A benchmark artifact is still being written: {exc.msg}"},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Open the local Tau2 Inspector")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8005)
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser")
    parser.add_argument(
        "--allow-network",
        action="store_true",
        help="Allow binding to a non-loopback host (exposes local benchmark data)",
    )
    args = parser.parse_args()
    loopback_hosts = {"127.0.0.1", "localhost", "::1"}
    if args.host not in loopback_hosts and not args.allow_network:
        parser.error(
            "Non-loopback hosts require --allow-network because the viewer exposes "
            "task scenarios, fixture records, and raw provider payloads."
        )
    url = f"http://{args.host}:{args.port}"
    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print(f"Tau2 Inspector: {url}")
    if args.host not in loopback_hosts:
        print("Warning: viewer data is available to other devices on this network.")
    print("Watching airline domain data and data/simulations for changes.")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

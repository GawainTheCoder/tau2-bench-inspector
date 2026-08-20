"""Evidence-first cohort analysis for the Tau2 Inspector workbench."""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any, Callable

TAXONOMY = {
    "A": "Missing prerequisite information",
    "B": "Policy/eligibility reasoning error",
    "C": "Premature mutation",
    "D": "Wrong mutation/tool arguments",
    "E": "Required confirmation missing",
    "F": "Workflow abandoned before completion",
    "G": "Correct state change, wrong communication",
    "H": "Unnecessary/escalated path",
    "I": "Other / unclear",
}

_CONFIRMATION = re.compile(
    r"^(?:yes(?:\s*,?\s*please)?|yes\s+please\s+proceed|please\s+proceed|"
    r"go\s+ahead|confirmed?|do\s+it|proceed)(?:[.!\s]|$)",
    re.IGNORECASE,
)


def _display_text(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value
    if isinstance(parsed, dict):
        for key in ("message", "response"):
            if isinstance(parsed.get(key), str):
                return parsed[key]
    return value


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _scenario_type(task: dict[str, Any]) -> str:
    criteria = task.get("evaluation_criteria") or {}
    actions = criteria.get("actions") or []
    names = [str(action.get("name") or "") for action in actions]
    writes = [
        name for name in names if name.startswith(("book_", "cancel_", "update_"))
    ]
    purpose = ((task.get("description") or {}).get("purpose") or "").casefold()
    if len(set(writes)) > 1:
        return "Multi-action workflow"
    if "book_reservation" in names:
        return "Booking"
    if "cancel_reservation" in names:
        return "Cancellation"
    if "update_reservation_passengers" in names:
        return "Passenger change"
    if (
        "update_reservation_baggages" in names
        and "update_reservation_flights" not in names
    ):
        return "Baggage change"
    if "update_reservation_flights" in names:
        return "Flight / cabin change"
    if "compensation" in purpose or "voucher" in purpose:
        return "Compensation"
    if "insurance" in purpose or "refund" in purpose:
        return "Refund / insurance"
    if "cancel" in purpose:
        return "Cancellation eligibility"
    return "Policy / information"


def _task_map(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(task.get("id")): task for task in data.get("tasks") or []}


def _messages(simulation: dict[str, Any]) -> list[dict[str, Any]]:
    return simulation.get("messages") or []


def _tool_steps(
    simulation: dict[str, Any], tool_types: dict[str, str]
) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    for message_index, message in enumerate(_messages(simulation)):
        if message.get("role") not in {"assistant", "user"}:
            continue
        for call in message.get("tool_calls") or []:
            requestor = call.get("requestor") or message.get("role")
            if requestor != "assistant":
                continue
            name = str(call.get("name") or "unknown_tool")
            steps.append(
                {
                    "index": len(steps) + 1,
                    "name": name,
                    "arguments": call.get("arguments") or {},
                    "turn": message.get("turn_idx", message_index),
                    "type": tool_types.get(name, "unknown"),
                    "is_write": tool_types.get(name) == "write",
                }
            )
    return steps


def _confirmation_for_writes(
    simulation: dict[str, Any], steps: list[dict[str, Any]]
) -> dict[str, Any]:
    writes = [step for step in steps if step["is_write"]]
    if not writes:
        return {
            "status": "not_applicable",
            "label": "Not applicable",
            "confirmed": 0,
            "write_count": 0,
            "evidence": None,
        }
    user_messages = [
        {
            "turn": message.get("turn_idx", index),
            "content": _display_text(message.get("content")),
        }
        for index, message in enumerate(_messages(simulation))
        if message.get("role") == "user"
    ]
    confirmed = 0
    evidence: str | None = None
    for write in writes:
        prior = [item for item in user_messages if item["turn"] < write["turn"]]
        confirmations = [
            item for item in prior if _CONFIRMATION.search(item["content"].strip())
        ]
        last = confirmations[-1] if confirmations else None
        if last:
            confirmed += 1
            evidence = last["content"]
    status = "yes" if confirmed == len(writes) else "mixed" if confirmed else "no"
    return {
        "status": status,
        "label": {"yes": "Yes", "mixed": "Mixed", "no": "No"}[status],
        "confirmed": confirmed,
        "write_count": len(writes),
        "evidence": evidence,
    }


def _reference_actions(task: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "name": action.get("name"),
            "arguments": action.get("arguments") or {},
            "requestor": action.get("requestor") or "assistant",
        }
        for action in (task.get("evaluation_criteria") or {}).get("actions") or []
    ]


def _repeat_analysis(steps: list[dict[str, Any]]) -> dict[str, Any]:
    names = Counter(step["name"] for step in steps)
    repeated_names = [
        {"name": name, "count": count, "extra_calls": count - 1}
        for name, count in sorted(names.items())
        if count > 1
    ]
    signatures: dict[tuple[str, str], dict[str, Any]] = {}
    for step in steps:
        key = (step["name"], _canonical(step["arguments"]))
        entry = signatures.setdefault(
            key,
            {"name": step["name"], "arguments": step["arguments"], "count": 0},
        )
        entry["count"] += 1
    repeated_arguments = [
        {**entry, "extra_calls": entry["count"] - 1}
        for entry in signatures.values()
        if entry["count"] > 1
    ]
    return {
        "names": repeated_names,
        "arguments": repeated_arguments,
        "name_repeat_count": sum(item["extra_calls"] for item in repeated_names),
        "argument_repeat_count": sum(
            item["extra_calls"] for item in repeated_arguments
        ),
    }


def _multi_call_turns(simulation: dict[str, Any]) -> int:
    return sum(
        len(message.get("tool_calls") or []) > 1
        for message in _messages(simulation)
        if message.get("role") == "assistant"
    )


def _reward_values(simulation: dict[str, Any]) -> tuple[Any, Any, Any]:
    reward_info = simulation.get("reward_info") or {}
    breakdown = reward_info.get("reward_breakdown") or {}
    return reward_info.get("reward"), breakdown.get("DB"), breakdown.get("COMMUNICATE")


def _last_assistant_message(simulation: dict[str, Any]) -> str:
    for message in reversed(_messages(simulation)):
        if message.get("role") == "assistant" and message.get("content") is not None:
            return _display_text(message.get("content"))
    return "No final assistant message was recorded."


def _base_run(
    simulation: dict[str, Any],
    task: dict[str, Any],
    tool_types: dict[str, str],
    run_key: str,
) -> dict[str, Any]:
    steps = _tool_steps(simulation, tool_types)
    writes = [step for step in steps if step["is_write"]]
    repeats = _repeat_analysis(steps)
    reward, db_reward, communicate_reward = _reward_values(simulation)
    total_cost = (simulation.get("agent_cost") or 0) + (
        simulation.get("user_cost") or 0
    )
    return {
        "run_key": run_key,
        "simulation_id": simulation.get("id"),
        "task_id": str(simulation.get("task_id")),
        "purpose": (task.get("description") or {}).get("purpose") or "Untitled task",
        "scenario_type": _scenario_type(task),
        "reward": reward,
        "db_reward": db_reward,
        "communicate_reward": communicate_reward,
        "tool_sequence": steps,
        "tool_names": [step["name"] for step in steps],
        "write_tool_called": bool(writes),
        "write_calls": writes,
        "confirmation": _confirmation_for_writes(simulation, steps),
        "final_outcome": {
            "termination_reason": simulation.get("termination_reason"),
            "assistant_message": _last_assistant_message(simulation),
            "db_matched": db_reward == 1,
            "communication_matched": communicate_reward == 1,
        },
        "turn_count": len(_messages(simulation)),
        "tool_count": len(steps),
        "duration": simulation.get("duration"),
        "agent_cost": simulation.get("agent_cost"),
        "user_cost": simulation.get("user_cost"),
        "total_cost": total_cost,
        "repeats": repeats,
        "transfer_count": sum(
            step["name"] == "transfer_to_human_agents" for step in steps
        ),
        "multi_call_turns": _multi_call_turns(simulation),
        "reference_actions": _reference_actions(task),
    }


def _fallback_failure_annotation(run: dict[str, Any]) -> dict[str, Any]:
    reference_writes = [
        action
        for action in run["reference_actions"]
        if action["name"].startswith(("book_", "cancel_", "update_"))
    ]
    actual_writes = run["write_calls"]
    if reference_writes and not actual_writes:
        return {
            "categories": ["F"],
            "prerequisites_retrieved": "unclear",
            "mechanism": (
                "Agent never completed the evaluator-expected mutation; the stored "
                "trajectory ended without a write tool call."
            ),
            "evidence": ["No write tool call is present in the saved trajectory."],
        }
    if not reference_writes and actual_writes:
        return {
            "categories": ["C"],
            "prerequisites_retrieved": "unclear",
            "mechanism": (
                "Agent mutated the reservation even though the evaluator reference "
                "path required no database write."
            ),
            "evidence": [
                "The saved trajectory contains a write, while the reference task contains none."
            ],
        }
    return {
        "categories": ["I"],
        "prerequisites_retrieved": "unclear",
        "mechanism": (
            "The final database state did not match the evaluator expectation; the "
            "stored evidence needs manual review before assigning a narrower mechanism."
        ),
        "evidence": ["DB reward is 0 for this run."],
    }


def _failure_row(
    run: dict[str, Any], annotation: dict[str, Any] | None
) -> dict[str, Any]:
    note = annotation or _fallback_failure_annotation(run)
    categories = [code for code in note.get("categories") or [] if code in TAXONOMY]
    confirmation = dict(run["confirmation"])
    if note.get("confirmation_status"):
        confirmation.update(
            {
                "status": note["confirmation_status"],
                "label": note.get("confirmation_label")
                or note["confirmation_status"].replace("_", " ").title(),
                "evidence": note.get("confirmation_evidence")
                or confirmation.get("evidence"),
            }
        )
    return {
        **run,
        "confirmation": confirmation,
        "categories": categories,
        "category_labels": [TAXONOMY[code] for code in categories],
        "prerequisites_retrieved": note.get("prerequisites_retrieved", "unclear"),
        "observed_failure_mechanism": note.get("mechanism")
        or _fallback_failure_annotation(run)["mechanism"],
        "evidence": note.get("evidence") or [],
        "annotation_status": "reviewed" if annotation else "provisional",
    }


def _percentile_rank(value: float, values: list[float]) -> int:
    if not values:
        return 0
    below_or_equal = sum(candidate <= value for candidate in values)
    return round(100 * below_or_equal / len(values))


def _success_analysis(
    run: dict[str, Any],
    cohort: list[dict[str, Any]],
    annotation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    reference_names = [action["name"] for action in run["reference_actions"]]
    reference_counts = Counter(reference_names)
    actual_counts = Counter(run["tool_names"])
    exact_extras = run["repeats"]["argument_repeat_count"]
    count_over_reference = sum(
        max(0, count - reference_counts.get(name, 0))
        for name, count in actual_counts.items()
        if name not in {"get_user_details", "get_reservation_details"}
    )
    unexpected_transfer = (
        run["transfer_count"] > 0 and "transfer_to_human_agents" not in reference_names
    )
    confirmation_risk = run["confirmation"]["status"] in {"no", "mixed"}
    policy_risk = run["multi_call_turns"] > 0
    inefficient = exact_extras > 0 or count_over_reference > 2
    brittle = unexpected_transfer or confirmation_risk or policy_risk
    if inefficient and brittle:
        classification = "inefficient + brittle"
    elif inefficient:
        classification = "inefficient"
    elif brittle:
        classification = "brittle"
    else:
        classification = "clean"

    findings: list[str] = []
    if run["repeats"]["arguments"]:
        findings.append(
            f"Repeated {exact_extras} tool call(s) with identical arguments."
        )
    if run["multi_call_turns"]:
        findings.append(
            f"Issued multiple tool calls in {run['multi_call_turns']} assistant turn(s), contrary to the one-call-at-a-time policy."
        )
    if unexpected_transfer:
        findings.append(
            "Transferred even though transfer was not in the evaluator reference path."
        )
    if confirmation_risk:
        findings.append(
            "At least one write was not immediately preceded by an explicit user confirmation."
        )
    if not findings:
        findings.append(
            "No exact duplicate, unexpected transfer, or confirmation/pacing risk was detected."
        )

    costs = [float(item["total_cost"] or 0) for item in cohort]
    durations = [float(item["duration"] or 0) for item in cohort]
    cost_percentile = _percentile_rank(float(run["total_cost"] or 0), costs)
    duration_percentile = _percentile_rank(float(run["duration"] or 0), durations)
    extra_visible = inefficient or brittle
    high_impact = extra_visible and (cost_percentile >= 75 or duration_percentile >= 75)
    if high_impact:
        impact = (
            f"Material association: this run is at the {cost_percentile}th cost "
            f"percentile and {duration_percentile}th duration percentile. The trace "
            "shows extra/risky work, but one run cannot establish causality."
        )
    elif extra_visible:
        impact = (
            f"Extra or risky work is visible, but the run is only at the "
            f"{cost_percentile}th cost and {duration_percentile}th duration percentiles; "
            "no material increase is established from this trace alone."
        )
    else:
        impact = "No clearly redundant step was identified, so no extra-work cost or latency is attributed."

    risk_score = (
        exact_extras * 3
        + count_over_reference
        + run["multi_call_turns"] * 3
        + run["transfer_count"] * 2
        + (4 if unexpected_transfer else 0)
        + (5 if confirmation_risk else 0)
    )
    necessary = reference_names or [
        "No mutation was required; the necessary outcome was policy-compliant communication and an unchanged database."
    ]
    if annotation:
        classification = annotation.get("classification", classification)
        findings = annotation.get("findings") or findings
        impact = annotation.get("impact") or impact
        necessary = annotation.get("necessary_steps") or necessary
        risk_score = {
            "clean": 0,
            "inefficient": 6,
            "brittle": 8,
            "inefficient + brittle": 12,
        }.get(classification, risk_score) + exact_extras
    return {
        **run,
        "classification": classification,
        "review_label": (annotation or {}).get("review_label", classification),
        "review_status": "reviewed" if annotation else "provisional",
        "risk_score": risk_score,
        "cost_percentile": cost_percentile,
        "duration_percentile": duration_percentile,
        "what_was_the_task": run["purpose"],
        "path_taken": run["tool_names"],
        "necessary_steps": necessary,
        "necessary_steps_basis": "Evaluator reference actions; informational prerequisites may not be exhaustively encoded.",
        "redundant_avoidable_or_risky": findings,
        "material_cost_latency_impact": impact,
    }


def _assign_ranks(successes: list[dict[str, Any]]) -> None:
    metrics: dict[str, Callable[[dict[str, Any]], float]] = {
        "tool_count": lambda item: float(item["tool_count"] or 0),
        "turn_count": lambda item: float(item["turn_count"] or 0),
        "duration": lambda item: float(item["duration"] or 0),
        "cost": lambda item: float(item["total_cost"] or 0),
        "repeated_tool_names": lambda item: float(item["repeats"]["name_repeat_count"]),
        "repeated_arguments": lambda item: float(
            item["repeats"]["argument_repeat_count"]
        ),
        "transfers": lambda item: float(item["transfer_count"]),
        "risk_score": lambda item: float(item["risk_score"]),
    }
    for metric, getter in metrics.items():
        ordered = sorted(
            successes,
            key=lambda item: (-getter(item), int(item["task_id"])),
        )
        for rank, item in enumerate(ordered, 1):
            item.setdefault("ranks", {})[metric] = rank


def build_workbench(
    data: dict[str, Any],
    simulations: list[dict[str, Any]],
    *,
    batch: dict[str, Any],
    tool_types: dict[str, str],
    run_key_for: Callable[[dict[str, Any], int], str],
    annotations: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a transparent failure and success review for one saved cohort."""
    tasks = _task_map(data)
    annotation_tasks = (annotations or {}).get("tasks") or {}
    annotation_successes = (annotations or {}).get("successes") or {}
    base_runs: list[dict[str, Any]] = []
    for index, simulation in enumerate(simulations):
        reward, _, _ = _reward_values(simulation)
        if reward is None:
            continue
        task_id = str(simulation.get("task_id"))
        task = tasks.get(task_id) or {}
        base_runs.append(
            _base_run(
                simulation,
                task,
                tool_types,
                run_key_for(simulation, index),
            )
        )

    failed_base = [run for run in base_runs if run["reward"] != 1]
    successful_base = [run for run in base_runs if run["reward"] == 1]
    failures = [
        _failure_row(run, annotation_tasks.get(run["task_id"])) for run in failed_base
    ]
    successes = [
        _success_analysis(
            run,
            successful_base,
            annotation_successes.get(run["task_id"]),
        )
        for run in successful_base
    ]
    _assign_ranks(successes)
    failures.sort(key=lambda item: int(item["task_id"]))
    successes.sort(key=lambda item: (-item["risk_score"], int(item["task_id"])))

    taxonomy_counts = Counter(
        code for failure in failures for code in failure["categories"]
    )
    classification_counts = Counter(success["classification"] for success in successes)
    return {
        "schema_version": 1,
        "batch": batch,
        "summary": {
            "total_runs": len(base_runs),
            "failure_count": len(failures),
            "success_count": len(successes),
            "reviewed_failure_count": sum(
                item["annotation_status"] == "reviewed" for item in failures
            ),
            "success_classifications": dict(classification_counts),
        },
        "taxonomy": [
            {
                "code": code,
                "label": label,
                "count": taxonomy_counts.get(code, 0),
            }
            for code, label in TAXONOMY.items()
        ],
        "failures": failures,
        "successes": successes,
        "methodology": {
            "observed_mechanism_label": "Observed failure mechanism",
            "failure_note": "Mechanisms describe stored behavior; they are not causal claims.",
            "success_note": "Reference actions come from task evaluation criteria. Efficiency and brittleness labels are Inspector heuristics and remain reviewable against the raw trajectory.",
            "impact_note": "Cost and duration comparisons are within this successful cohort and do not establish causality.",
        },
    }

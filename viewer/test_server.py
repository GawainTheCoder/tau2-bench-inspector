"""Focused tests for the local Tau2 Inspector server."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from viewer import server

client = TestClient(server.app)


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _simulation(simulation_id: str, content: str) -> dict:
    return {
        "id": simulation_id,
        "task_id": "1",
        "timestamp": "2026-08-20T10:00:00",
        "duration": 1.0,
        "termination_reason": "user_stop",
        "agent_cost": 0.01,
        "user_cost": 0.001,
        "reward_info": {
            "reward": 1.0,
            "reward_basis": ["DB", "COMMUNICATE"],
            "reward_breakdown": {"DB": 1.0, "COMMUNICATE": 1.0},
        },
        "messages": [
            {
                "role": "assistant",
                "content": content,
                "turn_idx": 0,
                "timestamp": "2026-08-20T10:00:00",
            }
        ],
        "ticks": None,
        "trial": 0,
        "mode": "half_duplex",
        "info": None,
        "policy": "# Test policy",
    }


class ViewerServerTests(unittest.TestCase):
    def test_http_smoke_and_airline_scope(self) -> None:
        root = client.get("/")
        self.assertEqual(root.status_code, 200)
        self.assertIn("Tau2 Inspector", root.text)
        self.assertEqual(root.headers["cache-control"], "no-store")
        self.assertEqual(root.headers["x-content-type-options"], "nosniff")
        self.assertEqual(root.headers["x-frame-options"], "DENY")
        self.assertIn("script-src 'self'", root.headers["content-security-policy"])
        self.assertNotIn(
            "'unsafe-inline'",
            root.headers["content-security-policy"].split("style-src")[0],
        )

        result_helpers = client.get("/assets/result_utils.mjs")
        self.assertEqual(result_helpers.status_code, 200)
        self.assertIn("parseToolResult", result_helpers.text)
        self.assertEqual(result_helpers.headers["cache-control"], "no-store")

        theme_bootstrap = client.get("/assets/theme_bootstrap.js")
        self.assertEqual(theme_bootstrap.status_code, 200)
        self.assertIn("tau2-inspector-theme", theme_bootstrap.text)

        response = client.get("/api/bootstrap")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["domain"], "airline")
        self.assertEqual(len(data["tasks"]), 50)
        self.assertEqual(len(data["tools"]), 14)
        self.assertEqual(
            data["database"],
            {"flights": 300, "users": 500, "reservations": 2000},
        )
        self.assertTrue(data["runs"])
        self.assertTrue(all(run["domain"] == "airline" for run in data["runs"]))
        self.assertTrue(
            all("mock_llm_agent" not in run["folder"] for run in data["runs"])
        )
        self.assertTrue(data["evaluations"])
        self.assertTrue(
            all(item["evaluated_count"] >= 0 for item in data["evaluations"])
        )
        self.assertTrue(
            all("mock_llm_agent" not in item["folder"] for item in data["evaluations"])
        )

    def test_workbench_analyzes_full_airline_cohort(self) -> None:
        response = client.get("/api/workbench")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(
            data["batch"]["file"],
            "airline_all_50_gpt_5_4_mini_medium_responses/results.json",
        )
        self.assertEqual(
            data["summary"],
            {
                "total_runs": 50,
                "failure_count": 19,
                "success_count": 31,
                "reviewed_failure_count": 19,
                "success_classifications": {
                    "clean": 18,
                    "inefficient": 3,
                    "brittle": 9,
                    "inefficient + brittle": 1,
                },
            },
        )
        self.assertEqual(
            {item["code"]: item["count"] for item in data["taxonomy"]},
            {"A": 2, "B": 1, "C": 1, "D": 5, "E": 1, "F": 1, "G": 0, "H": 6, "I": 2},
        )
        self.assertNotIn("root cause", json.dumps(data).lower())
        self.assertTrue(
            all(item["annotation_status"] == "reviewed" for item in data["failures"])
        )
        self.assertTrue(
            all("messages" not in item for item in data["failures"] + data["successes"])
        )

        failures = {item["task_id"]: item for item in data["failures"]}
        self.assertEqual(failures["12"]["confirmation"]["label"], "Before pricing")
        self.assertEqual(failures["24"]["confirmation"]["label"], "No · terms changed")
        self.assertEqual(
            sum(item["write_tool_called"] for item in data["failures"]), 10
        )

        successes = {item["task_id"]: item for item in data["successes"]}
        self.assertEqual(successes["4"]["classification"], "clean")
        self.assertEqual(successes["4"]["tool_count"], 17)
        self.assertEqual(successes["33"]["classification"], "inefficient")
        self.assertEqual(successes["33"]["repeats"]["argument_repeat_count"], 2)
        self.assertEqual(successes["15"]["classification"], "inefficient + brittle")

        for row in data["failures"] + data["successes"]:
            detail = client.get(f"/api/runs/{row['run_key']}")
            self.assertEqual(detail.status_code, 200)
            self.assertEqual(detail.json()["simulation"]["id"], row["simulation_id"])

    def test_invalid_evaluation_key_returns_404(self) -> None:
        response = client.get("/api/workbench", params={"evaluation_key": "not-real"})
        self.assertEqual(response.status_code, 404)

    def test_current_run_details_cover_success_failure_and_error(self) -> None:
        runs = client.get("/api/bootstrap").json()["runs"]
        self.assertTrue(any(run["reward"] == 1 for run in runs))
        self.assertTrue(any(run["reward"] == 0 for run in runs))
        self.assertTrue(any(run["reward"] is None and run["has_error"] for run in runs))

        passing = next(run for run in runs if run["reward"] == 1)
        detail = client.get(f"/api/runs/{passing['key']}").json()
        self.assertEqual(detail["simulation"]["task_id"], passing["task_id"])
        self.assertTrue(detail["messages"])
        self.assertIsInstance(detail["trajectory"], list)
        self.assertNotIn("raw", detail)

        raw = client.get(f"/api/runs/{passing['key']}?include_raw=true").json()
        self.assertEqual(
            raw["raw"]["selected_simulation"]["id"], passing["simulation_id"]
        )

    def test_database_search_is_paginated(self) -> None:
        response = client.get(
            "/api/database/users", params={"q": "raj_sanchez", "limit": 1}
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertGreaterEqual(data["total"], 1)
        self.assertEqual(len(data["items"]), 1)
        self.assertIn("raj_sanchez", json.dumps(data["items"][0]).lower())

    def test_directory_run_keys_remain_stable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            results_root = Path(temp_dir) / "results"
            run_dir = results_root / "voice_run"
            metadata = {
                "timestamp": "2026-08-20T10:00:00",
                "info": {
                    "agent_info": {"llm": "gpt-5.6-luna"},
                    "user_info": {"llm": "gpt-5.6-luna"},
                    "environment_info": {
                        "domain_name": "airline",
                        "policy": "# Policy",
                    },
                },
                "tasks": [
                    {"id": "1", "description": {"purpose": "Stable directory test"}}
                ],
                "simulation_index": [
                    {
                        "id": "sim-b",
                        "task_id": "1",
                        "trial": 0,
                        "reward": 1.0,
                        "termination_reason": "user_stop",
                        "agent_cost": 0.01,
                        "duration": 1.0,
                    }
                ],
            }
            _write_json(run_dir / "results.json", metadata)
            _write_json(
                run_dir / "simulations" / "sim-b.json",
                _simulation("sim-b", "B"),
            )
            with patch.object(server, "RESULTS_DIR", results_root):
                run = server._run_summaries()[0]
                stable_key = run["key"]
                self.assertEqual(
                    server._run_detail(stable_key)["messages"][0]["display_content"],
                    "B",
                )

                metadata["simulation_index"].insert(
                    0,
                    {
                        "id": "sim-a",
                        "task_id": "1",
                        "trial": 1,
                        "reward": 0.0,
                        "termination_reason": "user_stop",
                        "agent_cost": 0.02,
                        "duration": 2.0,
                    },
                )
                _write_json(run_dir / "results.json", metadata)
                _write_json(
                    run_dir / "simulations" / "sim-a.json",
                    _simulation("sim-a", "A"),
                )

                self.assertEqual(
                    server._run_detail(stable_key)["messages"][0]["display_content"],
                    "B",
                )
                raw = server._run_detail(stable_key, include_raw=True)["raw"]
                self.assertEqual(raw["selected_simulation"]["id"], "sim-b")

    def test_full_duplex_ticks_are_flattened_and_requestor_scoped(self) -> None:
        tick = {
            "tick_id": 7,
            "timestamp": "2026-08-20T10:00:00",
            "agent_chunk": {
                "role": "assistant",
                "content": "agent chunk",
                "turn_idx": None,
                "timestamp": "2026-08-20T10:00:00",
            },
            "user_chunk": {
                "role": "user",
                "content": "user chunk",
                "turn_idx": None,
                "timestamp": "2026-08-20T10:00:00",
            },
            "agent_tool_calls": [
                {
                    "id": "shared-id",
                    "name": "get_user_details",
                    "arguments": {"user_id": "agent"},
                    "requestor": "assistant",
                }
            ],
            "user_tool_calls": [
                {
                    "id": "shared-id",
                    "name": "get_user_details",
                    "arguments": {"user_id": "user"},
                    "requestor": "user",
                }
            ],
            "agent_tool_results": [
                {
                    "role": "tool",
                    "id": "shared-id",
                    "requestor": "assistant",
                    "content": "agent result",
                    "turn_idx": None,
                }
            ],
            "user_tool_results": [
                {
                    "role": "tool",
                    "id": "shared-id",
                    "requestor": "user",
                    "content": "user result",
                    "turn_idx": None,
                }
            ],
        }
        messages = server._messages_for_simulation({"messages": None, "ticks": [tick]})
        self.assertEqual([message["turn_idx"] for message in messages], list(range(4)))
        self.assertTrue(all(message["tick_id"] == 7 for message in messages))

        trajectory = server._tool_trajectory(messages, {"get_user_details": "read"})
        paired = {item["requestor"]: item["result"] for item in trajectory}
        self.assertEqual(paired, {"assistant": "agent result", "user": "user result"})

    def test_invalid_run_key_returns_404(self) -> None:
        with self.assertRaises(HTTPException) as context:
            server._run_detail("not-a-real-run-key")
        self.assertEqual(context.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()

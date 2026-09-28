import os

import pytest
from litellm.types.llms.openai import ResponsesAPIResponse

from tau2.data_model.message import (
    AssistantMessage,
    Message,
    SystemMessage,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from tau2.environment.tool import Tool, as_tool
from tau2.utils.llm_utils import generate, to_responses_input


@pytest.fixture
def model() -> str:
    return "gpt-4o-mini"


@pytest.fixture
def messages() -> list[Message]:
    messages = [
        SystemMessage(role="system", content="You are a helpful assistant."),
        UserMessage(role="user", content="What is the capital of the moon?"),
    ]
    return messages


@pytest.fixture
def tool() -> Tool:
    def calculate_square(x: int) -> int:
        """Calculate the square of a number.
            Args:
            x (int): The number to calculate the square of.
        Returns:
            int: The square of the number.
        """
        return x * x

    return as_tool(calculate_square)


@pytest.fixture
def tool_call_messages() -> list[Message]:
    messages = [
        SystemMessage(role="system", content="You are a helpful assistant."),
        UserMessage(
            role="user",
            content="What is the square of 5? Just give me the number, no explanation.",
        ),
    ]
    return messages


@pytest.mark.skipif(
    os.getenv("TAU2_RUN_LIVE_LLM_TESTS") != "1",
    reason="Live provider test requires an explicit paid-run opt-in",
)
def test_generate_no_tool_call(model: str, messages: list[Message]):
    response = generate(model, messages)
    assert isinstance(response, AssistantMessage)
    assert response.content is not None


@pytest.mark.skipif(
    os.getenv("TAU2_RUN_LIVE_LLM_TESTS") != "1",
    reason="Live provider test requires an explicit paid-run opt-in",
)
def test_generate_tool_call(model: str, tool_call_messages: list[Message], tool: Tool):
    response = generate(model, tool_call_messages, tools=[tool])
    assert isinstance(response, AssistantMessage)
    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].name == "calculate_square"
    assert response.tool_calls[0].arguments == {"x": 5}
    follow_up_messages = [
        response,
        ToolMessage(role="tool", id=response.tool_calls[0].id, content="25"),
    ]
    response = generate(
        model,
        tool_call_messages + follow_up_messages,
        tools=[tool],
    )
    assert isinstance(response, AssistantMessage)
    assert response.tool_calls is None
    assert response.content == "25"


def test_to_responses_input_preserves_function_call_history():
    messages = [
        SystemMessage(role="system", content="Use tools."),
        UserMessage(role="user", content="Square five."),
        AssistantMessage(
            role="assistant",
            tool_calls=[
                ToolCall(id="call_123", name="calculate_square", arguments={"x": 5})
            ],
            raw_data={
                "output": [
                    {
                        "type": "reasoning",
                        "id": "rs_123",
                        "encrypted_content": "encrypted-reasoning-context",
                        "summary": [],
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_123",
                        "name": "calculate_square",
                        "arguments": '{"x":5}',
                    },
                ]
            },
        ),
        ToolMessage(role="tool", id="call_123", content="25"),
    ]

    assert to_responses_input(messages) == [
        {"role": "system", "content": "Use tools."},
        {"role": "user", "content": "Square five."},
        {
            "type": "reasoning",
            "id": "rs_123",
            "encrypted_content": "encrypted-reasoning-context",
            "summary": [],
        },
        {
            "type": "function_call",
            "call_id": "call_123",
            "name": "calculate_square",
            "arguments": '{"x":5}',
        },
        {"type": "function_call_output", "call_id": "call_123", "output": "25"},
    ]


@pytest.mark.parametrize(
    "responses_model",
    ["gpt-5.4-mini", "gpt-5.6-luna", "openai/gpt-5.4-mini"],
)
def test_generate_reasoning_model_uses_responses_api(
    monkeypatch: pytest.MonkeyPatch, tool: Tool, responses_model: str
):
    captured_request = {}

    def fake_responses(**kwargs):
        captured_request.update(kwargs)
        return ResponsesAPIResponse(
            id="resp_test",
            created_at=0,
            model=responses_model,
            status="completed",
            output=[
                {
                    "type": "function_call",
                    "id": "fc_test",
                    "call_id": "call_test",
                    "name": "calculate_square",
                    "arguments": '{"x":5}',
                    "status": "completed",
                }
            ],
            usage={"input_tokens": 20, "output_tokens": 8, "total_tokens": 28},
        )

    def fail_completion(**kwargs):
        raise AssertionError(f"Unexpected Chat Completions request: {kwargs}")

    monkeypatch.setattr("tau2.utils.llm_utils.litellm.responses", fake_responses)
    monkeypatch.setattr("tau2.utils.llm_utils.completion", fail_completion)

    response = generate(
        responses_model,
        [
            SystemMessage(role="system", content="Use tools."),
            UserMessage(role="user", content="Square five."),
        ],
        tools=[tool],
        temperature=0,
        reasoning_effort="medium",
    )

    assert captured_request["reasoning"] == {"effort": "medium"}
    assert "temperature" not in captured_request
    assert captured_request["store"] is False
    assert captured_request["tools"][0]["name"] == "calculate_square"
    assert "function" not in captured_request["tools"][0]
    assert response.tool_calls == [
        ToolCall(id="call_test", name="calculate_square", arguments={"x": 5})
    ]
    assert response.usage == {"completion_tokens": 8, "prompt_tokens": 20}


def test_generate_5_4_mini_preserves_temperature_at_default_none(
    monkeypatch: pytest.MonkeyPatch,
):
    captured_request = {}

    def fake_responses(**kwargs):
        captured_request.update(kwargs)
        return ResponsesAPIResponse(
            id="resp_test",
            created_at=0,
            model="gpt-5.4-mini",
            status="completed",
            output=[
                {
                    "type": "message",
                    "id": "msg_test",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Hello",
                            "annotations": [],
                        }
                    ],
                }
            ],
            usage={"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
        )

    monkeypatch.setattr("tau2.utils.llm_utils.litellm.responses", fake_responses)

    response = generate(
        "gpt-5.4-mini",
        [UserMessage(role="user", content="Hello")],
        temperature=0,
    )

    assert captured_request["temperature"] == 0
    assert "reasoning" not in captured_request
    assert response.content == "Hello"

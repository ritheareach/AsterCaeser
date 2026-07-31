from src.chatgpt_subscription import build_responses_input


def test_responses_input_preserves_function_calls_and_outputs():
    items = build_responses_input([
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call_1",
            "function": {"name": "write_file", "arguments": '{"path":"hello.txt"}'},
        }]},
        {"role": "tool", "tool_call_id": "call_1", "content": "written"},
    ])

    assert items == [
        {"type": "function_call", "call_id": "call_1", "name": "write_file", "arguments": '{"path":"hello.txt"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": "written"},
    ]

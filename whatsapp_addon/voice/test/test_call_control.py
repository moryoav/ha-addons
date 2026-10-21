import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "bridge"))
from call_control import decision_request, end_call_decision


class CallControlTests(unittest.TestCase):
    def response(self, arguments, **fields):
        return {"status": "completed", "output": [{"type": "function_call", "name": "end_whatsapp_call",
                "arguments": json.dumps(arguments)}], **fields}

    def test_only_a_completed_valid_end_call_tool_can_disconnect(self):
        decision = {"reason": "clear_goodbye"}
        self.assertEqual(end_call_decision(self.response(decision)), decision)
        for arguments in ({}, {"reason": "guess"}, {"reason": "clear_goodbye", "extra": True}, []):
            self.assertIsNone(end_call_decision(self.response(arguments)))
        self.assertIsNone(end_call_decision(self.response(decision, status="incomplete")))
        self.assertIsNone(end_call_decision({"status": "completed", "output": []}))

    def test_detector_context_does_not_depend_on_caption_delivery_order(self):
        request = decision_request("Thank you. Goodbye.", "Goodbye!", "Thank you. Goodbye.")
        context = json.loads(request["input"][0]["content"])
        self.assertEqual(context["latest_caller_utterance"], "Thank you. Goodbye.")
        self.assertNotIn("assistant_spoke_after_latest_caller", context)
        self.assertEqual(request["tools"][0]["parameters"]["required"], ["reason"])

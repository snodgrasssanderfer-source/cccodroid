import copy
import importlib.util
import json
import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch


# 服务测试隔离压缩和规则；它们各自用真实牌局样本测试。
dependencies = {}
for name, functions in {
    "events": ["diff_events"],
    "rules": ["legal_actions", "validate_action"],
    "state": ["compact_state"],
}.items():
    module = types.ModuleType(name)
    for function in functions:
        setattr(module, function, Mock())
    dependencies[name] = module
with patch.dict(sys.modules, dependencies):
    spec = importlib.util.spec_from_file_location(
        "bridge_service_under_test", Path(__file__).resolve().parents[1] / "bridge.py"
    )
    service = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(service)


def raw_state(score=0, ready=True):
    return {"state": "SELECTING_HAND", "score": score, "bridge": {"ready": ready}}


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class ScriptedRpc:
    def __init__(self, states):
        self.states = list(states)
        self.calls = []
        self.reads = 0

    def call(self, method, params=None):
        self.calls.append((method, copy.deepcopy(params)))
        if method == "bridge_state":
            index = min(self.reads, len(self.states) - 1)
            self.reads += 1
            return copy.deepcopy(self.states[index])
        return {"accepted": True}


class SignallingCondition(threading.Condition):
    def __init__(self):
        super().__init__()
        self.waiting = threading.Event()

    def wait(self, timeout=None):
        self.waiting.set()
        return super().wait(timeout)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.options = {
            "play": {"properties": {"cards": {"type": "array", "minItems": 1}},
                     "required": ["cards"]}
        }
        self.compact = patch.object(
            service, "compact_state",
            side_effect=lambda raw: {"state": raw["state"], "score": raw["score"]},
        )
        self.legal = patch.object(service, "legal_actions", return_value=self.options)
        self.validate = patch.object(
            service, "validate_action",
            side_effect=lambda raw, request: (
                request["action"], {key: value for key, value in request.items() if key != "action"}
            ),
        )
        self.diff = patch.object(service, "diff_events", return_value=[])
        self.compact.start()
        self.legal.start()
        self.validate_mock = self.validate.start()
        self.diff_mock = self.diff.start()
        self.addCleanup(patch.stopall)

    def test_invalid_action_is_not_sent_and_returns_current_options(self):
        rpc = ScriptedRpc([raw_state()])
        bridge = service.Bridge(rpc)
        self.validate_mock.side_effect = ValueError("card 8 is outside the hand")

        status, result = bridge.act({"action": "play", "cards": [8]})

        self.assertEqual(status, 400)
        self.assertFalse(result["ok"])
        self.assertIn("card 8", result["error"])
        self.assertEqual(result["state"]["actions"], self.options)
        self.assertEqual(rpc.calls, [("bridge_state", None)])

    def test_busy_game_has_no_actions_and_does_not_receive_request(self):
        rpc = ScriptedRpc([raw_state(ready=False)])
        bridge = service.Bridge(rpc)

        status, result = bridge.act({"action": "play", "cards": [0]})

        self.assertEqual(status, 400)
        self.assertEqual(result["state"]["actions"], {})
        self.validate_mock.assert_not_called()
        self.assertEqual(rpc.calls, [("bridge_state", None)])

    def test_action_is_sent_once_and_waits_for_ready_then_stable(self):
        # 动画中画面数值可能长时间不变，不能因此提前交回给模型。
        busy = [raw_state(ready=False)] * 8
        rpc = ScriptedRpc([raw_state(), *busy, raw_state(score=80)])
        bridge = service.Bridge(rpc, poll=0.1, settle=0.35, action_timeout=5)
        clock = FakeClock()

        with patch.object(service, "time", clock):
            status, result = bridge.act({"action": "play", "cards": [0, 2]})

        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.assertEqual(result["state"]["score"], 80)
        self.assertEqual([call for call in rpc.calls if call[0] != "bridge_state"],
                         [("play", {"cards": [0, 2]})])
        self.assertGreaterEqual(result["elapsed_ms"], 1150)
        self.assertGreaterEqual(rpc.reads, 14)

    def test_stability_timeout_does_not_resend_the_action(self):
        rpc = ScriptedRpc([raw_state(), raw_state(ready=False)])
        bridge = service.Bridge(rpc, poll=0.1, settle=0.35, action_timeout=0.5)
        with patch.object(service, "time", FakeClock()):
            with self.assertRaises(service.GameError):
                bridge.act({"action": "play", "cards": [0]})
        self.assertEqual(sum(method == "play" for method, _ in rpc.calls), 1)

    def test_seq_changes_only_for_changed_state_and_snapshots_are_independent(self):
        bridge = service.Bridge(ScriptedRpc([]))
        raw = raw_state()
        first, _ = bridge.publish(raw)
        unchanged, events = bridge.publish(copy.deepcopy(raw))
        self.assertEqual(first["seq"], 1)
        self.assertEqual(unchanged["seq"], 1)
        self.assertEqual(events, [])

        first["score"] = 999
        raw["score"] = 10
        self.assertEqual(bridge.snapshot()["score"], 0)
        changed, _ = bridge.publish(raw)
        self.assertEqual(changed["seq"], 2)
        self.assertEqual(changed["score"], 10)

    def test_events_cursor_keeps_all_events_at_one_seq_without_replay(self):
        bridge = service.Bridge(ScriptedRpc([]))
        bridge.publish(raw_state())
        self.diff_mock.return_value = [
            {"type": "hand_played", "score": 80},
            {"type": "money_changed", "delta": 3},
        ]
        state, created = bridge.publish(raw_state(score=80), {"action": "play", "cards": [0]})

        batch = bridge.events_since(1, wait=0)
        self.assertEqual(batch["seq"], state["seq"])
        self.assertEqual(batch["events"], created)
        self.assertEqual(len(batch["events"]), 2)
        self.assertEqual({event["seq"] for event in batch["events"]}, {2})
        self.assertEqual(bridge.events_since(batch["seq"], wait=0), {"seq": 2, "events": []})

    def test_scoring_animation_does_not_publish_partial_or_lose_final_score(self):
        bridge = service.Bridge(ScriptedRpc([]))
        before = {**raw_state(score=100), "hands_played": 0}
        bridge.publish(before)
        self.diff_mock.side_effect = lambda old, new, action: [{
            "type": "hand_played", "score": new["score"] - old["score"]
        }]

        # 手数先增加，分数随后逐步上涨；任何一个中间帧都不是本次最终得分。
        first, first_events = bridge.publish({**raw_state(score=100, ready=False), "hands_played": 1})
        middle, middle_events = bridge.publish({**raw_state(score=120, ready=False), "hands_played": 1})
        self.assertEqual(first_events, [])
        self.assertEqual(middle_events, [])
        self.assertEqual(first["actions"], {})
        self.assertEqual(middle["actions"], {})
        self.diff_mock.assert_not_called()

        after = {**raw_state(score=180), "hands_played": 1}
        final, events = bridge.publish(after)
        self.diff_mock.assert_called_once_with(before, after, None)
        self.assertEqual(events, [{"seq": final["seq"], "type": "hand_played", "score": 80}])
        self.assertEqual(bridge.events_since(1, wait=0)["events"], events)
        bridge.publish(copy.deepcopy(after))
        self.assertEqual(bridge.events_since(final["seq"], wait=0)["events"], [])

    def test_long_poll_wakes_when_a_new_state_is_published(self):
        bridge = service.Bridge(ScriptedRpc([]))
        bridge.changed = SignallingCondition()
        bridge.publish(raw_state())
        self.diff_mock.return_value = [{"type": "hand_played", "score": 80}]
        with ThreadPoolExecutor(max_workers=1) as executor:
            waiting = executor.submit(bridge.events_since, 1, 2)
            self.assertTrue(bridge.changed.waiting.wait(1), "consumer never entered long polling")
            self.assertFalse(waiting.done())
            bridge.publish(raw_state(score=80))
            result = waiting.result(timeout=1)
        self.assertEqual(result["seq"], 2)
        self.assertEqual(result["events"], [{"seq": 2, "type": "hand_played", "score": 80}])

    def test_parallel_actions_are_serialized_for_the_single_connection_game(self):
        class ConcurrentRpc:
            def __init__(self):
                self.lock = threading.Lock()
                self.entered = threading.Event()
                self.release = threading.Event()
                self.overlap = threading.Event()
                self.active = 0
                self.maximum_active = 0
                self.score = 0
                self.calls = []

            def call(self, method, params=None):
                with self.lock:
                    first = not self.calls
                    self.calls.append((method, copy.deepcopy(params)))
                    self.active += 1
                    self.maximum_active = max(self.maximum_active, self.active)
                    if self.active > 1:
                        self.overlap.set()
                try:
                    if first:
                        self.entered.set()
                        if not self.release.wait(2):
                            raise AssertionError("test did not release its first RPC")
                    with self.lock:
                        if method == "play":
                            self.score += 1
                        return raw_state(self.score)
                finally:
                    with self.lock:
                        self.active -= 1

        rpc = ConcurrentRpc()
        bridge = service.Bridge(rpc, poll=0.001, settle=0, action_timeout=1)
        start = threading.Barrier(3)

        def act(card):
            start.wait(timeout=1)
            return bridge.act({"action": "play", "cards": [card]})

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(act, 0)
            second = executor.submit(act, 1)
            try:
                start.wait(timeout=1)
                self.assertTrue(rpc.entered.wait(1))
                self.assertFalse(rpc.overlap.wait(0.05))
            finally:
                rpc.release.set()
            results = [first.result(timeout=2), second.result(timeout=2)]

        self.assertEqual(rpc.maximum_active, 1)
        self.assertEqual([result[0] for result in results], [200, 200])
        self.assertEqual(sorted(result[1]["state"]["score"] for result in results), [1, 2])
        self.assertEqual(sum(method == "play" for method, _ in rpc.calls), 2)


class BossAlertTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = Path(__file__).resolve().parents[1]
        cls.real_modules = {}
        for name in ("state", "rules"):
            spec = importlib.util.spec_from_file_location("boss_test_" + name, directory / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            cls.real_modules[name] = module
        cls.alert = json.loads((directory / "tests/fixtures/boss_alert.json").read_text(encoding="utf-8"))
        cls.ready = json.loads((directory / "tests/fixtures/boss_ready.json").read_text(encoding="utf-8"))
        cls.blind_select = json.loads((directory / "tests/fixtures/blind_select.json").read_text(encoding="utf-8"))

    def setUp(self):
        for name, replacement in {
            "compact_state": self.real_modules["state"].compact_state,
            "legal_actions": self.real_modules["rules"].legal_actions,
            "validate_action": self.real_modules["rules"].validate_action,
            "diff_events": lambda before, after, action=None: [],
        }.items():
            patcher = patch.object(service, name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_recorded_boss_prompt_disables_actions_until_play_lock_clears(self):
        # raw-final/00017: Boss“头部”提示仍在显示，ready=true 不代表可出牌。
        self.assertTrue(self.alert["bridge"]["ready"])
        self.assertTrue(self.alert["bridge"]["play_blocked"])
        self.assertFalse(service.ready(self.alert))
        self.assertEqual(service.legal_actions(self.alert), {})
        with self.assertRaises(ValueError):
            service.validate_action(self.alert, {"action": "play", "cards": [0]})

        rpc = ScriptedRpc([self.alert])
        bridge = service.Bridge(rpc)
        status, result = bridge.act({"action": "play", "cards": [0]})
        self.assertEqual(status, 400)
        self.assertFalse(result["state"]["ready"])
        self.assertEqual(result["state"]["actions"], {})
        self.assertEqual(rpc.calls, [("bridge_state", None)])

        state, _ = bridge.publish(self.ready)
        self.assertTrue(state["ready"])
        self.assertIn("play", state["actions"])
        self.assertEqual(service.validate_action(self.ready, {"action": "play", "cards": [0]}),
                         ("play", {"cards": [0]}))

    def test_select_waits_through_repeated_ready_but_play_blocked_snapshots(self):
        rpc = ScriptedRpc([self.blind_select, *([self.alert] * 8), self.ready])
        bridge = service.Bridge(rpc, poll=0.1, settle=0.35, action_timeout=5)
        clock = FakeClock()
        with patch.object(service, "time", clock):
            status, result = bridge.act({"action": "select"})

        self.assertEqual(status, 200)
        self.assertTrue(result["state"]["ready"])
        self.assertIn("play", result["state"]["actions"])
        self.assertGreaterEqual(result["elapsed_ms"], 1150)
        self.assertGreaterEqual(rpc.reads, 14)
        self.assertEqual([call for call in rpc.calls if call[0] != "bridge_state"], [("select", {})])


if __name__ == "__main__":
    unittest.main()

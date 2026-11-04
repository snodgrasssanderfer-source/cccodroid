import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from events import diff_events
from test_state import card, sample


class EventTests(unittest.TestCase):
    def test_scored_hand_and_blind_clear_are_observed_once(self):
        before = sample()
        after = copy.deepcopy(before)
        after["state"] = "ROUND_EVAL"
        after["hands"]["Pair"].update(played=1, played_this_round=1)
        after["round"].update(chips=320, hands_played=1, hands_left=3)
        after["hand"]["cards"] = []
        events = diff_events(before, after, {"action": "play", "cards": [0, 1]})
        played = next(e for e in events if e["type"] == "hand_played")
        self.assertEqual(played["hand"], "Pair")
        self.assertEqual(played["score"], 320)
        self.assertEqual([c["rank"] for c in played["cards"]], ["A", "K"])
        self.assertEqual([e["type"] for e in events].count("blind_cleared"), 1)
        self.assertEqual(diff_events(after, after), [])
        shop = copy.deepcopy(after)
        shop["state"] = "SHOP"
        shop["blinds"]["small"]["status"] = "DEFEATED"
        self.assertNotIn("blind_cleared", [e["type"] for e in diff_events(after, shop)])

    def test_discard_does_not_become_hand_played(self):
        before, after = sample(), sample()
        after["round"].update(discards_used=1, discards_left=2)
        after["hand"]["cards"] = [card(4)]
        events = diff_events(before, after, {"action": "discard", "cards": [1]})
        self.assertEqual([e["type"] for e in events], ["discarded"])
        self.assertEqual(events[0]["cards"][0]["rank"], "K")

    def test_purchase_sale_and_pack_selection_have_items(self):
        before = sample() | {"state": "SHOP", "shop": {"cards": [card(8)]}, "money": 5}
        after = copy.deepcopy(before)
        after.update(money=4, shop={"cards": []})
        after["jokers"]["cards"] = [card(8)]
        events = diff_events(before, after, {"action": "buy", "card": 0})
        self.assertEqual([e["type"] for e in events], ["bought", "money_changed"])
        sold = copy.deepcopy(after)
        sold["jokers"]["cards"] = []
        sold["money"] = 6
        events = diff_events(after, sold, {"action": "sell", "joker": 0})
        self.assertEqual(events[0]["type"], "sold")
        opened = sample() | {"state": "SMODS_BOOSTER_OPENED", "pack": {"cards": [card(10)]}}
        closed = sample() | {"state": "SHOP"}
        events = diff_events(opened, closed, {"action": "pack", "card": 0})
        self.assertIn("pack_selected", [e["type"] for e in events])

    def test_reroll_is_not_reported_as_buying_every_item(self):
        before = sample() | {"state": "SHOP", "shop": {"cards": [card(8)]}, "money": 8}
        after = sample() | {"state": "SHOP", "shop": {"cards": [card(9)]}, "money": 3}
        self.assertEqual([e["type"] for e in diff_events(before, after, {"action": "reroll"})], ["money_changed"])

    def test_boss_hover_flag_is_not_an_observed_trigger(self):
        before, after = sample(), sample()
        for raw in (before, after):
            raw["bridge"]["blind"].update(key="bl_hook", name="The Hook", boss=True)
        after["bridge"]["blind"]["triggered"] = True
        self.assertEqual(diff_events(before, after), [])
        after["hands"]["Pair"]["played"] = 1
        events = diff_events(before, after, {"action": "play", "cards": [0]})
        self.assertEqual(next(e for e in events if e["type"] == "boss_effect")["phase"], "triggered")

    def test_game_over_and_money_changes_have_no_commentary(self):
        before = sample()
        after = copy.deepcopy(before)
        after.update(state="GAME_OVER", money=3)
        events = diff_events(before, after)
        self.assertEqual(events, [{"type": "money_changed", "before": 4, "after": 3, "delta": -1},
                                  {"type": "game_over", "won": False, "ante": 1, "round": 1}])


if __name__ == "__main__":
    unittest.main()


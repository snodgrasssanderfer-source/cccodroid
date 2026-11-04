import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from state import compact_state


def card(ident, rank="A", suit="S", **extra):
    result = {"id": ident, "key": f"{suit}_{rank}", "set": "DEFAULT", "label": "Base Card",
              "value": {"rank": rank, "suit": suit, "effect": "11 chips"},
              "modifier": {}, "state": {}, "cost": {"buy": 1, "sell": 0}}
    result.update(extra)
    return result


def sample():
    return {"state": "SELECTING_HAND", "ante_num": 1, "round_num": 1, "money": 4,
            "deck": "RED", "stake": "WHITE", "won": False,
            "hand": {"cards": [card(1), card(2, "K")], "limit": 8},
            "cards": {"cards": [card(3, "2", "H"), card(4, "2", "H")]},
            "jokers": {"cards": [], "limit": 5}, "consumables": {"cards": [], "limit": 2},
            "hands": {"Pair": {"order": 11, "chips": 10, "mult": 2, "level": 1,
                               "played": 0, "played_this_round": 0, "example": [["S_2", True]]}},
            "round": {"chips": 0, "hands_left": 4, "discards_left": 3, "hands_played": 0,
                      "discards_used": 0, "reroll_cost": 5},
            "blinds": {"small": {"name": "Small Blind", "type": "SMALL", "status": "CURRENT", "score": 300}},
            "bridge": {"ready": True, "forced_cards": [1], "language": "en-us",
                       "blind": {"key": "bl_small", "name": "Small Blind", "score": 300,
                                 "boss": False, "effect": "", "triggered": False, "disabled": False}}}


class CompactStateTests(unittest.TestCase):
    def test_playing_cards_keep_modifiers_and_forced_selection(self):
        raw = sample()
        raw["hand"]["cards"][0].update(set="ENHANCED", modifier={"enhancement": "GLASS", "seal": "RED", "edition": "FOIL"},
                                         state={"debuff": True, "hidden": True})
        before = copy.deepcopy(raw)
        state = compact_state(raw)
        self.assertEqual(state["hand"][0]["seal"], "RED")
        self.assertEqual(state["hand"][0]["edition"], "FOIL")
        self.assertTrue(state["hand"][0]["debuff"])
        self.assertTrue(state["hand"][1]["forced"])
        self.assertEqual(state["target"], 300)
        self.assertEqual(state["hand_values"]["Pair"]["mult"], 2)
        self.assertNotIn("example", state["hand_values"]["Pair"])
        self.assertEqual(state["deck_counts"], {"H2": 2})
        self.assertEqual(raw, before)
        self.assertNotIn("GLASS", state["spectator_text"])
        self.assertNotIn("黑桃", state["spectator_text"])

    def test_jokers_keep_full_effect_and_capacity_in_shop(self):
        raw = sample()
        raw["state"] = "SHOP"
        joker = card(8, set="JOKER", key="j_joker", name="小丑", value={"effect": "+4 倍率"},
                     modifier={"eternal": True, "rental": True}, cost={"buy": 5, "sell": 2})
        raw["jokers"]["cards"] = [joker]
        raw["shop"] = {"cards": [copy.deepcopy(joker)]}
        state = compact_state(raw)
        self.assertEqual(state["jokers"][0]["effect"], "+4 倍率")
        self.assertTrue(state["jokers"][0]["eternal"])
        self.assertEqual(state["jokers"][0]["sell"], 2)
        self.assertEqual(state["shop"]["cards"][0]["price"], 5)
        self.assertEqual(state["capacity"]["jokers"], 5)
        self.assertNotIn("hand_values", state)
        self.assertNotIn("hand", state)

    def test_pack_keeps_targets_and_remaining_choices(self):
        raw = sample()
        raw.update(state="SMODS_BOOSTER_OPENED", pack={"cards": [card(8)]})
        raw["bridge"]["pack_choices"] = 2
        state = compact_state(raw)
        self.assertEqual(state["pack_choices"], 2)
        self.assertEqual(state["pack"][0]["i"], 0)
        self.assertEqual(state["pack"][0]["rank"], "A")
        self.assertEqual(len(state["hand"]), 2)

    def test_menu_is_smaller_and_has_no_poker_examples(self):
        raw = json.loads((Path(__file__).parent / "fixtures/menu.json").read_text(encoding="utf-8-sig"))
        state = compact_state(raw)
        self.assertEqual(state["state"], "MENU")
        self.assertEqual(state["language"], "zh_CN")
        self.assertNotIn("hands", state)
        self.assertNotIn("hand_values", state)
        self.assertLess(len(json.dumps(state)), len(json.dumps(raw)) / 4)

    def test_recorded_hand_accepts_lua_empty_tables_as_arrays(self):
        raw = json.loads((Path(__file__).parent / "fixtures/hand.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(raw["hand"]["cards"][0]["modifier"], [])
        state = compact_state(raw)
        self.assertEqual(state["state"], "SELECTING_HAND")
        self.assertEqual(len(state["hand"]), len(raw["hand"]["cards"]))
        self.assertEqual(sum(state["deck_counts"].values()), len(raw["cards"]["cards"]))
        self.assertEqual(state["target"], raw["bridge"]["blind"]["score"])
        self.assertLess(len(json.dumps(state)), len(json.dumps(raw)) / 2)

    def test_recorded_shop_keeps_chinese_effects_and_live_prices(self):
        raw = json.loads((Path(__file__).parent / "fixtures/shop.json").read_text(encoding="utf-8"))
        state = compact_state(raw)
        self.assertEqual(state["money"], 10)
        item = state["shop"]["cards"][0]
        self.assertEqual(item["name"], "棒球卡")
        self.assertEqual(item["price"], 8)
        self.assertEqual(item["effect"], raw["shop"]["cards"][0]["value"]["effect"])
        self.assertEqual(state["reroll_cost"], raw["round"]["reroll_cost"])
        self.assertLess(len(json.dumps(state)), len(json.dumps(raw)) / 2)


if __name__ == "__main__":
    unittest.main()

import copy
import unittest

from rules import legal_actions, validate_action


def raw_state(state="SELECTING_HAND"):
    return {"state": state, "money": 5, "round": {"hands_left": 4, "discards_left": 3, "reroll_cost": 5},
            "hand": {"cards": [{"key": "S_A"} for _ in range(8)]},
            "jokers": {"cards": [], "limit": 5}, "consumables": {"cards": [], "limit": 2},
            "bridge": {"ready": True, "play_limit": 5, "discard_limit": 5, "forced_cards": [],
                       "available_money": 5, "starts": [{"deck": "RED", "stakes": ["WHITE"]}]}}


class RulesTest(unittest.TestCase):
    def test_index_count_duplicates_and_bool(self):
        raw = raw_state()
        self.assertEqual(validate_action(raw, {"action": "play", "cards": [0, 2, 4]}), ("play", {"cards": [0, 2, 4]}))
        for cards in ([], [0, 0], [8], [-1], [True], [0, 1, 2, 3, 4, 5]):
            with self.subTest(cards=cards), self.assertRaises(ValueError):
                validate_action(raw, {"action": "play", "cards": cards})

    def test_forced_and_no_discards(self):
        raw = raw_state()
        raw["bridge"]["forced_cards"] = [4]
        with self.assertRaises(ValueError):
            validate_action(raw, {"action": "play", "cards": [0]})
        validate_action(raw, {"action": "play", "cards": [0, 4]})
        raw["round"]["discards_left"] = 0
        self.assertNotIn("discard", legal_actions(raw))

    def test_animation_blocks_actions(self):
        raw = raw_state()
        raw["bridge"]["ready"] = False
        self.assertEqual(legal_actions(raw), {})

    def test_affordability_uses_credit_and_slots(self):
        raw = raw_state("SHOP")
        raw["money"] = -2
        raw["bridge"]["available_money"] = 18
        raw["shop"] = {"cards": [{"set": "JOKER", "cost": {"buy": 8}}, {"set": "JOKER", "cost": {"buy": 19}}]}
        validate_action(raw, {"action": "buy", "card": 0})
        with self.assertRaises(ValueError):
            validate_action(raw, {"action": "buy", "card": 1})
        self.assertIn("reroll", legal_actions(raw))
        raw["jokers"]["limit"] = 0
        self.assertNotIn("buy", legal_actions(raw))

    def test_consumable_targets_are_not_current_highlights(self):
        raw = raw_state()
        raw["consumables"]["cards"] = [{"key": "c_aura"}, {"key": "c_death"}]
        raw["bridge"]["consumables"] = [{"index": 0, "can_use": True, "targets": {"min": 1, "max": 1, "indices": [1, 3, 5]}},
                                         {"index": 1, "can_use": True, "targets": {"min": 2, "max": 2, "indices": list(range(8))}}]
        self.assertEqual(validate_action(raw, {"action": "use", "consumable": 0, "cards": [3]})[0], "bridge_use")
        validate_action(raw, {"action": "use", "consumable": 1, "cards": [7, 0]})
        for request in ({"action": "use", "consumable": 0, "cards": [2]}, {"action": "use", "consumable": 1, "cards": [1]}):
            with self.assertRaises(ValueError): validate_action(raw, request)

    def test_negative_purchase_matches_current_upstream_capacity_check(self):
        # Balatrobot 1.5.2 buy.lua checks existing capacity before negative's bonus.
        for kind, area in (("JOKER", "jokers"), ("TAROT", "consumables")):
            raw = raw_state("SHOP")
            raw[area] = {"cards": [{"key": "occupied"}], "limit": 1}
            raw["shop"] = {"cards": [{"set": kind, "modifier": {"edition": "NEGATIVE"}, "cost": {"buy": 1}}]}
            with self.subTest(kind=kind):
                self.assertNotIn("buy", legal_actions(raw))
                raw[area]["limit"] = 2
                validate_action(raw, {"action": "buy", "card": 0})

    def test_ankh_follows_live_game_space_check(self):
        raw = raw_state()
        raw["consumables"]["cards"] = [{"key": "c_ankh"}]
        raw["bridge"]["consumables"] = [{"index": 0, "can_use": False}]
        self.assertNotIn("use", legal_actions(raw))
        raw["bridge"]["consumables"][0]["can_use"] = True
        self.assertEqual(validate_action(raw, {"action": "use", "consumable": 0}), ("use", {"consumable": 0}))

    def test_rearrange_accepts_one_area_as_required_by_upstream(self):
        raw = raw_state()
        raw["jokers"]["cards"] = [{"key": "j_joker"}, {"key": "j_greedy_joker"}]
        validate_action(raw, {"action": "rearrange", "jokers": [1, 0]})
        with self.assertRaises(ValueError):
            validate_action(raw, {"action": "rearrange", "hand": list(range(8)), "jokers": [1, 0]})

    def test_pack_and_rearrange(self):
        raw = raw_state("SMODS_BOOSTER_OPENED")
        raw["bridge"]["pack"] = [{"index": 0, "can_select": True, "targets": {"min": 1, "max": 2, "indices": [0, 1]}}]
        validate_action(raw, {"action": "pack", "skip": True})
        validate_action(raw, {"action": "pack", "card": 0, "targets": [1]})
        validate_action(raw, {"action": "rearrange", "hand": list(reversed(range(8)))})
        for req in ({"action": "pack", "skip": True, "card": 0}, {"action": "rearrange", "hand": [0]}, {"action": "pack", "skip": False}):
            with self.assertRaises(ValueError): validate_action(raw, req)

    def test_no_unknown_fields_or_boss_skip(self):
        raw = raw_state("BLIND_SELECT")
        raw["blinds"] = {"boss": {"type": "BOSS", "status": "SELECT"}}
        self.assertNotIn("skip", legal_actions(raw))
        with self.assertRaises(ValueError): validate_action(raw, {"action": "select", "cards": [0]})

    def test_start_and_gameover(self):
        raw = raw_state("MENU")
        self.assertEqual(validate_action(raw, {"action": "start", "deck": "RED", "stake": "WHITE", "seed": "BRIDGE111"}),
                         ("bridge_start", {"deck": "RED", "stake": "WHITE", "seed": "BRIDGE111"}))
        with self.assertRaises(ValueError): validate_action(raw, {"action": "start", "deck": "BLUE", "stake": "WHITE"})
        raw["state"] = "GAME_OVER"
        self.assertEqual(legal_actions(raw), {"menu": {"type": "object", "properties": {}, "required": [], "additionalProperties": False}})


if __name__ == "__main__":
    unittest.main()


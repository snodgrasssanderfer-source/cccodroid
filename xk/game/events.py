"""Events describe observed changes, not strategy or commentary."""

from state import area_cards, compact_card


def _inventory(raw, area):
    return {card["id"]: card for card in area_cards(raw, area)}


def _changed_cards(before, after, area):
    remaining = _inventory(after, area)
    return [card for card in area_cards(before, area) if card["id"] not in remaining]


def _selected_cards(before, after, action):
    hand = area_cards(before, "hand")
    if action and "cards" in action:
        cards = [hand[i] for i in action["cards"]]
    else:
        cards = _changed_cards(before, after, "hand")
    return [compact_card(card, playing=True) for card in cards]


def _current_blind(raw):
    live = (raw.get("bridge") or {}).get("blind")
    if live and live.get("name"):
        return live
    return next((b for b in (raw.get("blinds") or {}).values()
                 if b.get("status") == "CURRENT"), {})


def diff_events(before, after, action=None):
    if not before or before == after:
        return []
    events = []
    action = action or {}
    name = action.get("action")
    old_round, new_round = before.get("round") or {}, after.get("round") or {}
    same_round = before.get("round_num") == after.get("round_num")
    played = {name: hand.get("played", 0) - (before.get("hands") or {}).get(name, {}).get("played", 0)
              for name, hand in (after.get("hands") or {}).items()}
    played = {name: count for name, count in played.items() if count > 0}
    if played and before.get("state") != "MENU" and name != "start":
        event = {"type": "hand_played", "cards": _selected_cards(before, after, action),
                 "hands": played}
        if len(played) == 1:
            event["hand"] = next(iter(played))
        if same_round:
            event["score"] = new_round.get("chips", 0) - old_round.get("chips", 0)
        events.append(event)
    discarded = new_round.get("discards_used", 0) - old_round.get("discards_used", 0)
    if same_round and discarded > 0:
        events.append({"type": "discarded", "cards": _selected_cards(before, after, action),
                       "count": discarded})

    old_blind, new_blind = _current_blind(before), _current_blind(after)
    if after.get("state") == "ROUND_EVAL" and before.get("state") != "ROUND_EVAL":
        blind = old_blind or new_blind
        events.append({"type": "blind_cleared", "name": blind.get("name", ""),
                       "blind": blind.get("key") or blind.get("type", ""),
                       "score": new_round.get("chips", 0), "target": blind.get("score", 0)})
    boss = new_blind.get("boss") or new_blind.get("type") == "BOSS"
    if boss and (new_blind.get("key", new_blind.get("name")) !=
                 old_blind.get("key", old_blind.get("name"))):
        events.append({"type": "boss_effect", "phase": "active", "name": new_blind.get("name", ""),
                       "effect": new_blind.get("effect", "")})
    if boss and played and new_blind.get("triggered") and not old_blind.get("triggered"):
        events.append({"type": "boss_effect", "phase": "triggered", "name": new_blind.get("name", ""),
                       "effect": new_blind.get("effect", "")})
    if boss and new_blind.get("disabled") and not old_blind.get("disabled"):
        events.append({"type": "boss_effect", "phase": "disabled", "name": new_blind.get("name", "")})

    # Shop removal plus an unchanged shop phase distinguishes a purchase from reroll/exit.
    if before.get("state") == "SHOP" and name != "reroll":
        for param, area in (("card", "shop"), ("voucher", "vouchers"), ("pack", "packs")):
            gone = _changed_cards(before, after, area)
            if name == "buy" and param in action:
                card = area_cards(before, area)[action[param]]
                if card in gone or after.get("state") == "SMODS_BOOSTER_OPENED":
                    events.append({"type": "bought", "kind": param, "item": compact_card(card),
                                   "price": card.get("cost", {}).get("buy", 0)})
            elif not name and after.get("state") in ("SHOP", "SMODS_BOOSTER_OPENED"):
                for card in gone:
                    if after.get("state") == "SHOP" or area == "packs":
                        events.append({"type": "shop_item_removed", "kind": param,
                                       "item": compact_card(card)})
    if name == "sell":
        for param, area in (("joker", "jokers"), ("consumable", "consumables")):
            if param in action:
                card = area_cards(before, area)[action[param]]
                if card in _changed_cards(before, after, area):
                    events.append({"type": "sold", "kind": param, "item": compact_card(card),
                                   "price": card.get("cost", {}).get("sell", 0)})
    elif not name and before.get("state") in ("SHOP", "SELECTING_HAND"):
        for area in ("jokers", "consumables"):
            for card in _changed_cards(before, after, area):
                events.append({"type": "inventory_item_removed", "area": area, "item": compact_card(card)})
    if before.get("state") != "SMODS_BOOSTER_OPENED" and after.get("state") == "SMODS_BOOSTER_OPENED":
        events.append({"type": "pack_opened", "items": len(area_cards(after, "pack"))})
    if name == "pack" and before.get("state") == "SMODS_BOOSTER_OPENED":
        if "card" in action:
            card = area_cards(before, "pack")[action["card"]]
            if card in _changed_cards(before, after, "pack") or after.get("state") != before.get("state"):
                events.append({"type": "pack_selected", "item": compact_card(card),
                               "targets": action.get("targets", [])})
        elif action.get("skip") and after.get("state") != before.get("state"):
            events.append({"type": "pack_skipped"})
    if name == "use" and "consumable" in action:
        card = area_cards(before, "consumables")[action["consumable"]]
        events.append({"type": "consumable_used", "item": compact_card(card),
                       "targets": action.get("cards", [])})
    for key, blind in (after.get("blinds") or {}).items():
        if (blind.get("status") == "SKIPPED" and (before.get("blinds") or {}).get(key, {}).get("status") != "SKIPPED"
                and before.get("ante_num") == after.get("ante_num")):
            events.append({"type": "blind_skipped", "blind": key, "name": blind.get("name", ""),
                           "tag": blind.get("tag_name", ""), "effect": blind.get("tag_effect", "")})
    if before.get("money") != after.get("money") and "money" in before and "money" in after:
        events.append({"type": "money_changed", "before": before["money"], "after": after["money"],
                       "delta": after["money"] - before["money"]})
    if after.get("won") and not before.get("won"):
        events.append({"type": "game_won", "ante": after.get("ante_num"), "round": after.get("round_num")})
    if after.get("state") == "GAME_OVER" and before.get("state") != "GAME_OVER":
        events.append({"type": "game_over", "won": bool(after.get("won")),
                       "ante": after.get("ante_num"), "round": after.get("round_num")})
    return events

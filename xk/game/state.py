"""Keep decision data while removing repeated card/UI serialization."""

from collections import Counter


def area_cards(raw, area):
    return (raw.get(area) or {}).get("cards", [])


def compact_card(card, index=None, *, playing=False, price=False):
    value = card.get("value") or {}
    result = {} if index is None else {"i": index}
    result.update({k: value[k] for k in ("rank", "suit") if k in value})
    if not playing:
        result.update(name=card.get("name") or card.get("label") or card.get("key", ""),
                      key=card.get("key", ""), set=card.get("set", ""))
    if value.get("effect") and (not playing or card.get("set") != "DEFAULT"):
        result["effect"] = value["effect"]
    result.update(card.get("modifier") or {})
    result.update(card.get("state") or {})
    cost = card.get("cost") or {}
    if price:
        result["price"] = cost.get("buy", 0)
    elif not playing:
        result["sell"] = cost.get("sell", 0)
    return result


def _blind(raw):
    live = (raw.get("bridge") or {}).get("blind")
    if live and live.get("name"):
        return dict(live)
    return next((dict(b) for b in (raw.get("blinds") or {}).values()
                 if b.get("status") == "CURRENT"), None)


def _deck_counts(raw):
    # Preserve composition for discard decisions, without serializing UI text per card.
    counts = Counter()
    for card in area_cards(raw, "cards"):
        value, modifier = card.get("value") or {}, card.get("modifier") or {}
        key = f"{value.get('suit', '?')}{value.get('rank', '?')}"
        for field, value in sorted(modifier.items()):
            key += f"/{field}={value}"
        counts[key] += 1
    return dict(sorted(counts.items()))


def compact_state(raw):
    stage = raw.get("state", "UNKNOWN")
    meta = raw.get("bridge") or {}
    result = {"state": stage}
    for source, target in (("ante_num", "ante"), ("round_num", "round"),
                           ("money", "money"), ("deck", "deck"), ("stake", "stake")):
        if source in raw:
            result[target] = raw[source]
    if raw.get("won"):
        result["won"] = True
    if "ready" in meta:
        result["ready"] = meta["ready"]
    if meta.get("language"):
        result["language"] = meta["language"]
    for area in ("jokers", "consumables"):
        result[area] = [compact_card(card, i) for i, card in enumerate(area_cards(raw, area))]
    result["capacity"] = {a: (raw.get(a) or {}).get("limit", 0)
                          for a in ("jokers", "consumables")}
    if raw.get("used_vouchers"):
        result["used_vouchers"] = raw["used_vouchers"]
    if "available_money" in meta and meta["available_money"] != raw.get("money"):
        result["available_money"] = meta["available_money"]

    if stage not in ("MENU", "UNKNOWN"):
        blind = _blind(raw)
        if blind:
            result["blind"] = blind
        result["blinds"] = raw.get("blinds") or {}
    if stage in ("SELECTING_HAND", "SMODS_BOOSTER_OPENED"):
        forced = set(meta.get("forced_cards", []))
        result["hand"] = []
        for i, card in enumerate(area_cards(raw, "hand")):
            item = compact_card(card, i, playing=True)
            if i in forced:
                item["forced"] = True
            result["hand"].append(item)
        result["hand_limit"] = (raw.get("hand") or {}).get("limit", 0)
        result["deck_remaining"] = len(area_cards(raw, "cards"))
        result["deck_counts"] = _deck_counts(raw)
    if stage == "SELECTING_HAND":
        current = raw.get("round") or {}
        result.update({k: current[k] for k in
                       ("hands_left", "discards_left", "hands_played", "discards_used")
                       if k in current})
        result["score"] = current.get("chips", 0)
        result["target"] = (result.get("blind") or {}).get("score", 0)
        result["hand_values"] = {
            name: {k: value[k] for k in ("level", "chips", "mult", "played", "played_this_round")
                   if k in value}
            for name, value in sorted((raw.get("hands") or {}).items(),
                                      key=lambda item: item[1].get("order", 0))
        }
        if meta.get("last_hand"):
            result["last_hand"] = meta["last_hand"]
    if stage == "SHOP":
        result["shop"] = {
            ("cards" if a == "shop" else a): [compact_card(card, i, price=True) for i, card in enumerate(area_cards(raw, a))]
            for a in ("shop", "vouchers", "packs")
        }
        result["reroll_cost"] = (raw.get("round") or {}).get("reroll_cost", 0)
    if stage == "SMODS_BOOSTER_OPENED":
        result["pack"] = [compact_card(card, i) for i, card in enumerate(area_cards(raw, "pack"))]
        if "pack_choices" in meta:
            result["pack_choices"] = meta["pack_choices"]
    if stage in ("ROUND_EVAL", "GAME_OVER"):
        result["score"] = (raw.get("round") or {}).get("chips", 0)
    result["spectator_text"] = spectator_text(result)
    return result


def spectator_text(state):
    stage = state["state"]
    if stage == "MENU":
        return "游戏停在主菜单，尚未进入牌局。"
    if stage == "SELECTING_HAND":
        return (f"当前 {state.get('score', 0)}/{state.get('target', 0)} 分，"
                f"手里有 {len(state.get('hand', []))} 张牌。"
                f"剩余 {state.get('hands_left', 0)} 次出牌、{state.get('discards_left', 0)} 次弃牌。")
    if stage == "BLIND_SELECT":
        selected = next((b for b in state.get("blinds", {}).values()
                         if b.get("status") == "SELECT"), {})
        return f"正在选择盲注：{selected.get('name', '等待选择')}，目标 {selected.get('score', 0)} 分。"
    if stage == "SHOP":
        shop = state.get("shop", {})
        count = sum(len(v) for v in shop.values())
        return f"正在商店，货架上有 {count} 件商品，持有 ${state.get('money', 0)}。"
    if stage == "SMODS_BOOSTER_OPENED":
        return f"补充包已打开，有 {len(state.get('pack', []))} 个选项。"
    if stage == "ROUND_EVAL":
        return f"本轮进入结算，累计 {state.get('score', 0)} 分。"
    if stage == "GAME_OVER":
        return f"牌局结束，停在第 {state.get('ante', 0)} 底注。"
    return "游戏正在过渡画面，等待状态稳定。"


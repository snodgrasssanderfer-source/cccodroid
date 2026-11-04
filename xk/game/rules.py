"""Legal action schemas and validation for the live bridge_state snapshot."""

DECKS = ("RED", "BLUE", "YELLOW", "GREEN", "BLACK", "MAGIC", "NEBULA", "GHOST", "ABANDONED", "CHECKERED", "ZODIAC", "PAINTED", "ANAGLYPH", "PLASMA", "ERRATIC")
STAKES = ("WHITE", "RED", "GREEN", "BLACK", "BLUE", "PURPLE", "ORANGE", "GOLD")


def cards(raw, area):
    return (raw.get(area) or {}).get("cards", [])


def obj(properties=None, required=()):
    return {"type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False}


def choices(variants):
    return variants[0] if len(variants) == 1 else {"oneOf": variants}


def integer(value):
    return {"type": "integer", "const": value}


def indices(values, minimum=1, maximum=None, forced=()):
    result = {"type": "array", "items": {"type": "integer", "enum": list(values)}, "uniqueItems": True, "minItems": minimum, "maxItems": len(values) if maximum is None else maximum}
    if forced:
        result["allOf"] = [{"contains": {"const": i}} for i in forced]
    return result


def legal_actions(raw):
    """Return model-facing JSON schemas, derived from the same data we validate."""
    bridge = raw.get("bridge") or {}
    if not bridge.get("ready"):
        return {}
    state = raw.get("state")
    actions = {}
    hand = cards(raw, "hand")
    hand_indices = list(range(len(hand)))
    if state == "MENU":
        starts = bridge.get("starts", [])
        variants = [obj({"deck": {"const": s["deck"]}, "stake": {"type": "string", "enum": s["stakes"]}, "seed": {"type": "string"}}, ("deck", "stake")) for s in starts if s.get("stakes")]
        if variants:
            actions["start"] = choices(variants)
        return actions
    if state == "GAME_OVER":
        return {"menu": obj()}
    if state == "BLIND_SELECT":
        actions["select"] = obj()
        if any(b.get("status") == "SELECT" and b.get("type") != "BOSS" for b in raw.get("blinds", {}).values()):
            actions["skip"] = obj()
    if state == "SELECTING_HAND":
        round_info = raw.get("round") or {}
        forced = bridge.get("forced_cards", [])
        for action, counter, limit in (("play", "hands_left", "play_limit"), ("discard", "discards_left", "discard_limit")):
            cap = min(len(hand), bridge.get(limit, 0))
            if cap and round_info.get(counter, 0) > 0 and len(forced) <= cap and not (action == "play" and bridge.get("play_blocked")):
                actions[action] = obj({"cards": indices(hand_indices, max(1, len(forced)), cap, forced)}, ("cards",))
    if state == "ROUND_EVAL":
        actions["cash_out"] = obj()
    if state == "SHOP":
        actions["next_round"] = obj()
        available = bridge.get("available_money", raw.get("money", 0))
        cost = (raw.get("round") or {}).get("reroll_cost", 0)
        if cost <= 0 or cost <= available:
            actions["reroll"] = obj()
        buy = []
        for field, area in (("card", "shop"), ("voucher", "vouchers"), ("pack", "packs")):
            for i, card in enumerate(cards(raw, area)):
                cost = (card.get("cost") or {}).get("buy", 0)
                if cost > 0 and cost > available:
                    continue
                destination = "jokers" if card.get("set") == "JOKER" else "consumables" if card.get("set") in ("TAROT", "PLANET", "SPECTRAL") else None
                if destination:
                    inventory = raw.get(destination) or {}
                    if len(inventory.get("cards", [])) >= inventory.get("limit", 0):
                        continue
                buy.append(obj({field: integer(i)}, (field,)))
        if buy:
            actions["buy"] = choices(buy)
    if state in ("SELECTING_HAND", "SHOP"):
        sell = []
        for field, area in (("joker", "jokers"), ("consumable", "consumables")):
            for i in (bridge.get("sell") or {}).get(area, []):
                sell.append(obj({field: integer(i)}, (field,)))
        if sell:
            actions["sell"] = choices(sell)
        use = []
        for item in bridge.get("consumables", []):
            if not item.get("can_use"):
                continue
            properties = {"consumable": integer(item["index"])}
            required = ["consumable"]
            target = item.get("targets")
            if target:
                if state != "SELECTING_HAND":
                    continue
                properties["cards"] = indices(target["indices"], target["min"], target["max"])
                required.append("cards")
            use.append(obj(properties, required))
        if use:
            actions["use"] = choices(use)
    if state == "SMODS_BOOSTER_OPENED":
        variants = [obj({"skip": {"const": True}}, ("skip",))]
        for item in bridge.get("pack", []):
            if not item.get("can_select"):
                continue
            properties = {"card": integer(item["index"])}
            required = ["card"]
            if target := item.get("targets"):
                properties["targets"] = indices(target["indices"], target["min"], target["max"])
                required.append("targets")
            variants.append(obj(properties, required))
        actions["pack"] = choices(variants)
    if state in ("SELECTING_HAND", "SHOP", "SMODS_BOOSTER_OPENED"):
        variants = []
        for area in ("hand", "jokers", "consumables"):
            size = len(cards(raw, area))
            if size and (area != "hand" or state != "SHOP"):
                variants.append(obj({area: indices(range(size), size, size)}, (area,)))
        if variants:
            actions["rearrange"] = choices(variants)
    return actions


def _check(schema, value, path="params"):
    if "oneOf" in schema:
        errors = []
        for variant in schema["oneOf"]:
            try:
                _check(variant, value, path)
                return
            except ValueError as exc:
                errors.append(str(exc))
        raise ValueError("不符合任何当前合法选项: " + "; ".join(dict.fromkeys(errors)))
    if "const" in schema and (type(value) is not type(schema["const"]) or value != schema["const"]):
        raise ValueError(f"{path} 必须为 {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path} 必须在 {schema['enum']} 中")
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise ValueError(f"{path} 必须是对象")
        missing = set(schema.get("required", [])) - value.keys()
        if missing:
            raise ValueError(f"{path} 缺少参数 {sorted(missing)}")
        extra = value.keys() - schema["properties"].keys()
        if extra:
            raise ValueError(f"{path} 未知参数 {sorted(extra)}")
        for key, child in value.items():
            _check(schema["properties"][key], child, f"{path}.{key}")
    elif kind == "array":
        if not isinstance(value, list):
            raise ValueError(f"{path} 必须是数组")
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", len(value)):
            raise ValueError(f"{path} 需要 {schema.get('minItems', 0)}..{schema.get('maxItems')} 个序号")
        for child in value:
            _check(schema["items"], child, path + "[]")
        if schema.get("uniqueItems") and len(value) != len(set(value)):
            raise ValueError(f"{path} 序号不能重复")
    elif kind == "integer" and type(value) is not int:
        raise ValueError(f"{path} 必须是整数")
    elif kind == "string" and not isinstance(value, str):
        raise ValueError(f"{path} 必须是字符串")
    for child in schema.get("allOf", []):
        _check(child, value, path)
    if "contains" in schema:
        wanted = schema["contains"]["const"]
        if wanted not in value:
            raise ValueError(f"{path} 必须包含被 Boss 强制选中的牌 {wanted}")


def validate_action(raw, request):
    if not isinstance(request, dict):
        raise ValueError("动作请求必须是 JSON 对象")
    action = request.get("action")
    options = legal_actions(raw)
    if not isinstance(action, str) or action not in options:
        raise ValueError(f"状态 {raw.get('state')} 当前可用动作: {', '.join(options) or '无（动画处理中）'}")
    params = {key: value for key, value in request.items() if key != "action"}
    _check(options[action], params)
    if action == "start":
        return "bridge_start", params
    if action == "use" and cards(raw, "consumables")[params["consumable"]].get("key") == "c_aura":
        return "bridge_use", params
    return action, params


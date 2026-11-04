-- Dynamic game rules are read here; decisions stay with the calling model.
local state_names = {MENU=true, BLIND_SELECT=true, SELECTING_HAND=true, ROUND_EVAL=true,
    SHOP=true, SMODS_BOOSTER_OPENED=true, GAME_OVER=true}
local deck_names = {b_red='RED', b_blue='BLUE', b_yellow='YELLOW', b_green='GREEN', b_black='BLACK',
    b_magic='MAGIC', b_nebula='NEBULA', b_ghost='GHOST', b_abandoned='ABANDONED', b_checkered='CHECKERED',
    b_zodiac='ZODIAC', b_painted='PAINTED', b_anaglyph='ANAGLYPH', b_plasma='PLASMA', b_erratic='ERRATIC'}
local stake_names = {'WHITE', 'RED', 'GREEN', 'BLACK', 'BLUE', 'PURPLE', 'ORANGE', 'GOLD'}

local function area_cards(area)
    return area and area.cards or {}
end

local function localized_name(card)
    local center = card.config and card.config.center
    if center and center.set == 'Default' then return '' end
    if center and center.key and center.set then
        return localize{type='name_text', key=center.key, set=center.set}
    end
    return card.label or ''
end

local function target_info(card)
    local ability = card.ability.consumeable
    local key = card.config.center.key
    local maximum = ability and ability.max_highlighted
    if key == 'c_aura' then maximum = 1 end
    if not maximum then return nil end
    local indices = {}
    for i, hand_card in ipairs(area_cards(G.hand)) do
        if key ~= 'c_aura' or not hand_card.edition then indices[#indices+1] = i-1 end
    end
    return {min=(ability and ability.min_highlighted) or 1, max=maximum, indices=indices}
end

local function can_use(card, target)
    if card.config.center.key == 'c_ankh' and #area_cards(G.jokers) >= G.jokers.config.card_limit then return false end
    if target and #target.indices < target.min then return false end
    -- Native can_use reads highlights, so evaluate a potential valid selection without clicking.
    local old_highlighted = G.hand and G.hand.highlighted
    if target then
        G.hand.highlighted = {}
        for n=1,target.min do G.hand.highlighted[n] = G.hand.cards[target.indices[n]+1] end
    end
    local ok, result = pcall(function() return card:can_use_consumeable() end)
    if target then G.hand.highlighted = old_highlighted end
    if not ok then error(result) end
    return result == true
end

local function describe_area(raw, raw_key, game_area)
    for i, card in ipairs(area_cards(game_area)) do
        if raw[raw_key] and raw[raw_key].cards[i] then raw[raw_key].cards[i].name = localized_name(card) end
    end
end

local function snapshot()
    local raw = BB_GAMESTATE.get_gamestate()
    local pending = 0
    for _, event in ipairs(G.E_MANAGER.queues.base) do
        if event.blocking and not event.complete then pending = pending+1 end
    end
    local terminal = raw.state == 'MENU' or raw.state == 'GAME_OVER'
    local locked = G.CONTROLLER.locked or (G.GAME.STOP_USE or 0) > 0
    for _, lock in pairs(G.CONTROLLER.locks) do if lock then locked = true end end
    local b = {ready=state_names[raw.state] == true and (terminal or
        (G.STATE_COMPLETE == true and not locked and pending == 0)),
        pending_events=pending, play_blocked=G.GAME.blind and G.GAME.blind.block_play == true,
        forced_cards={}, available_money=(G.GAME.dollars or 0)-(G.GAME.bankrupt_at or 0),
        pack_choices=G.GAME.pack_choices or 0, consumables={}, pack={}, sell={jokers={}, consumables={}},
        starts={}, language=G.SETTINGS.language, last_hand=G.GAME.last_hand_played}
    local limit = G.hand and G.hand.config.highlighted_limit or 0
    local starting = G.GAME.starting_params or {}
    b.play_limit = math.min(limit, math.max(starting.play_limit or limit, 1))
    b.discard_limit = math.min(limit, math.max(starting.discard_limit or limit, 0))
    for i, card in ipairs(area_cards(G.hand)) do
        if card.ability.forced_selection then b.forced_cards[#b.forced_cards+1] = i-1 end
    end
    for _, spec in ipairs{{'hand', G.hand}, {'jokers', G.jokers}, {'consumables', G.consumeables},
        {'shop', G.shop_jokers}, {'vouchers', G.shop_vouchers}, {'packs', G.shop_booster}, {'pack', G.pack_cards}} do
        describe_area(raw, spec[1], spec[2])
    end
    for i, card in ipairs(area_cards(G.jokers)) do
        if card:can_sell_card() then b.sell.jokers[#b.sell.jokers+1] = i-1 end
    end
    for i, card in ipairs(area_cards(G.consumeables)) do
        if card:can_sell_card() then b.sell.consumables[#b.sell.consumables+1] = i-1 end
        local target = target_info(card)
        b.consumables[i] = {index=i-1, can_use=can_use(card,target), targets=target}
    end
    for i, card in ipairs(area_cards(G.pack_cards)) do
        local target = target_info(card)
        local selectable = true
        if card.ability.set == 'Joker' then
            selectable = #area_cards(G.jokers) < G.jokers.config.card_limit
        elseif card.ability.consumeable then
            selectable = can_use(card,target)
        end
        b.pack[i] = {index=i-1, can_select=selectable, targets=target}
    end
    local blind = G.GAME.blind
    if blind and blind.config and blind.config.blind then
        local key = blind.config.blind.key
        b.blind = {key=key, name=key and localize{type='name_text', key=key, set='Blind'} or blind.name,
            effect=blind.loc_debuff_text or '', score=blind.chips or 0, boss=blind.boss == true,
            disabled=blind.disabled == true, triggered=blind.triggered == true}
    end
    for _, center in ipairs(G.P_CENTER_POOLS.Back) do
        local deck = deck_names[center.key]
        if deck and center.unlocked then
            local maximum = math.min(get_deck_win_stake(center.key)+1, #stake_names)
            if G.PROFILES[G.SETTINGS.profile].all_unlocked then maximum = #stake_names end
            local stakes = {}
            for n=1,maximum do stakes[n] = stake_names[n] end
            b.starts[#b.starts+1] = {deck=deck, stakes=stakes}
        end
    end
    raw.bridge = b
    return raw
end

assert(BB_DISPATCHER.register{
    name='bridge_state', description='Game state with decision rules and animation readiness', schema={},
    execute=function(_, send_response) send_response(snapshot()) end
})

-- Steamodded's new run setup no longer creates the legacy viewed_back used by start.lua.
assert(BB_DISPATCHER.register{
    name='bridge_start', description='Start a run with the Steamodded setup compatibility field',
    schema=BB_DISPATCHER.endpoints.start.schema,
    requires_state={G.STATES.MENU},
    execute=function(args, send_response)
        if not G.GAME.viewed_back then G.GAME.viewed_back = Back(G.P_CENTERS.b_red) end
        BB_DISPATCHER.endpoints.start.execute(args,send_response)
    end
})

-- Upstream use ignores Aura's cards because Aura lacks max_highlighted in its ability.
assert(BB_DISPATCHER.register{
    name='bridge_use', description='Use Aura with explicit target selection',
    schema=BB_DISPATCHER.endpoints.use.schema,
    requires_state={G.STATES.SELECTING_HAND, G.STATES.SHOP},
    execute=function(args, send_response)
        local card = G.consumeables.cards[args.consumable+1]
        if card and card.config.center.key == 'c_aura' and args.cards then
            for i=#G.hand.highlighted,1,-1 do G.hand:remove_from_highlighted(G.hand.highlighted[i],true) end
            for _, index in ipairs(args.cards) do G.hand:add_to_highlighted(G.hand.cards[index+1],true) end
        end
        BB_DISPATCHER.endpoints.use.execute(args,send_response)
    end
})


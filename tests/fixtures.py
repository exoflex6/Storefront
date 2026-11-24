"""Small fake catalog and storefront responses shaped like the real ones."""

from __future__ import annotations

import copy

from catalog import CURRENCY, Catalog

TIER_PREMIUM = "60bca009-4182-7998-dee7-b8a2558dc369"

SKIN_A = {"uuid": "skin-a", "level": "skin-a-lvl1", "name": "Prime Vandal"}
SKIN_B = {"uuid": "skin-b", "level": "skin-b-lvl1", "name": "Reaver Sheriff"}
SKIN_NM = {"uuid": "skin-nm", "level": "skin-nm-lvl1", "name": "Oni Phantom"}
BUDDY = {"uuid": "buddy-1", "level": "buddy-1-lvl1", "name": "Lucky Buddy"}
CARD = {"uuid": "card-1", "name": "Oni Card"}
BUNDLE = {"uuid": "bundle-1", "name": "Prime 2.0"}


def skin(s, tier=TIER_PREMIUM):
    return {
        "uuid": s["uuid"], "displayName": s["name"], "displayIcon": None, "contentTierUuid": tier,
        "levels": [{"uuid": s["level"], "displayIcon": f"https://img/{s['uuid']}.png"}],
    }


BP_SKIN = {"uuid": "skin-bp", "level": "skin-bp-lvl1", "name": "Ion Classic BP"}  # battle pass reward, tiered
AGENT_SPRAY = {"uuid": "spray-agent", "level": "spray-agent-lvl1", "name": "Agent Spray"}  # agent contract reward
PASS_SPRAY = {"uuid": "spray-pass", "level": "spray-pass-lvl1", "name": "Pass Spray"}


def contract(relation, *uuids, name="Episode 1 Act 1"):
    return {"displayName": name, "content": {"relationType": relation, "chapters": [
        {"levels": [{"reward": {"type": "x", "uuid": u}} for u in uuids], "freeRewards": None},
    ]}}


def fake_catalog(state_path=None) -> Catalog:
    catalog = Catalog(http=None, state_path=state_path)
    catalog.load(
        tiers=[{"uuid": TIER_PREMIUM, "devName": "Premium", "highlightColor": "d1548dff", "displayIcon": None}],
        skins=[skin(SKIN_A), skin(SKIN_B), skin(SKIN_NM), skin(BP_SKIN),
               {"uuid": "default", "displayName": "Standard Vandal", "contentTierUuid": None, "levels": []}],
        buddies=[{"uuid": BUDDY["uuid"], "displayName": BUDDY["name"], "displayIcon": "https://img/buddy.png",
                  "levels": [{"uuid": BUDDY["level"]}]}],
        sprays=[{"uuid": sp["uuid"], "displayName": sp["name"], "displayIcon": None, "levels": [{"uuid": sp["level"]}]}
                for sp in (AGENT_SPRAY, PASS_SPRAY)],
        cards=[{"uuid": CARD["uuid"], "displayName": CARD["name"], "displayIcon": "https://img/c.png",
                "largeArt": "https://img/c-large.png", "wideArt": "https://img/c-wide.png", "smallArt": "https://img/c-small.png"}],
        titles=[{"uuid": "title-1", "displayName": "Primed Title", "titleText": "Primed"}],
        flex=[],
        bundles=[{"uuid": BUNDLE["uuid"], "displayName": BUNDLE["name"], "displayIcon": "https://img/bundle.png"}],
        contracts=[
            contract("Season", BUDDY["level"], CARD["uuid"], "title-1", BP_SKIN["level"]),
            contract("Event", PASS_SPRAY["level"]),
            contract("Agent", AGENT_SPRAY["level"]),
        ],
    )
    return catalog


_STOREFRONT = {
    "SkinsPanelLayout": {
        "SingleItemOffers": [SKIN_A["level"], SKIN_B["level"]],
        "SingleItemStoreOffers": [
            {"OfferID": SKIN_A["level"], "Cost": {CURRENCY["VP"]: 1775}, "Rewards": [{"ItemID": SKIN_A["level"], "Quantity": 1}]},
            {"OfferID": SKIN_B["level"], "Cost": {CURRENCY["VP"]: 1275}, "Rewards": [{"ItemID": SKIN_B["level"], "Quantity": 1}]},
        ],
        "SingleItemOffersRemainingDurationInSeconds": 3600,
    },
    "AccessoryStore": {
        "AccessoryStoreOffers": [
            {"Offer": {"OfferID": "o-buddy", "Cost": {CURRENCY["KC"]: 4000}, "Rewards": [{"ItemID": BUDDY["level"], "Quantity": 1}]}},
        ],
        "AccessoryStoreRemainingDurationInSeconds": 5 * 86400,
    },
    "BonusStore": {
        "BonusStoreOffers": [{
            "Offer": {"Cost": {CURRENCY["VP"]: 1775}, "Rewards": [{"ItemID": SKIN_NM["level"]}]},
            "DiscountPercent": 30, "DiscountCosts": {CURRENCY["VP"]: 1242}, "IsSeen": False,
        }],
        "BonusStoreRemainingDurationInSeconds": 7 * 86400,
    },
    "FeaturedBundle": {
        "Bundles": [{
            "DataAssetID": BUNDLE["uuid"],
            "Items": [{"Item": {"ItemID": SKIN_A["level"], "Amount": 1}, "BasePrice": 1775, "DiscountedPrice": 1500, "IsPromoItem": False}],
            "TotalBaseCost": {CURRENCY["VP"]: 1775}, "TotalDiscountedCost": {CURRENCY["VP"]: 1500},
            "WholesaleOnly": False, "DurationRemainingInSeconds": 10 * 86400,
        }],
        "BundleRemainingDurationInSeconds": 10 * 86400,
    },
}


def storefront(*, night_market: bool = True) -> dict:
    raw = copy.deepcopy(_STOREFRONT)
    if not night_market:
        del raw["BonusStore"]
    return raw

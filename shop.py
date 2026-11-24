"""Turn a /store/v3/storefront response into the four sections the bot shows.

Reset times come from the response's remaining-duration fields, never hardcoded.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from catalog import CURRENCY, Catalog, Item

SECTIONS = ("daily", "accessories", "night_market", "bundles")
SECTION_LABEL = {
    "daily": "Daily shop",
    "accessories": "Accessories",
    "night_market": "Night market",
    "bundles": "Bundles",
}


@dataclass
class Offer:
    item: Item
    price: int | None = None
    base_price: int | None = None
    quantity: int = 1
    discount_percent: int = 0
    seen: bool = True
    promo: bool = False


@dataclass
class Section:
    resets_at: float | None
    offers: list[Offer] = field(default_factory=list)


@dataclass
class BundleOffer:
    uuid: str
    name: str
    icon: str | None
    resets_at: float | None
    price: int | None
    base_price: int | None
    wholesale_only: bool
    offers: list[Offer]


@dataclass
class Shop:
    fetched_at: float
    daily: Section
    accessories: Section
    night_market: Section | None
    bundles: list[BundleOffer]


def parse_storefront(raw: dict, catalog: Catalog, now: float | None = None) -> Shop:
    now = time.time() if now is None else now

    def at(seconds) -> float | None:
        return now + seconds if isinstance(seconds, (int, float)) else None

    def first_reward(offer) -> dict:
        rewards = (offer or {}).get("Rewards") or []
        return rewards[0] if rewards else {}

    panel = raw.get("SkinsPanelLayout") or {}
    daily = Section(
        resets_at=at(panel.get("SingleItemOffersRemainingDurationInSeconds")),
        offers=[
            Offer(item=catalog.item(first_reward(o).get("ItemID") or o.get("OfferID")),
                  price=(o.get("Cost") or {}).get(CURRENCY["VP"]))
            for o in panel.get("SingleItemStoreOffers") or []
        ],
    )

    store = raw.get("AccessoryStore") or {}
    accessories = Section(resets_at=at(store.get("AccessoryStoreRemainingDurationInSeconds")))
    for entry in store.get("AccessoryStoreOffers") or []:
        offer = entry.get("Offer") or {}
        reward = first_reward(offer)
        accessories.offers.append(Offer(
            item=catalog.item(reward.get("ItemID") or offer.get("OfferID")),
            quantity=reward.get("Quantity") or 1,
            price=(offer.get("Cost") or {}).get(CURRENCY["KC"]),
        ))

    # BonusStore is absent outside night market windows.
    bonus = raw.get("BonusStore")
    night_market = None
    if bonus:
        night_market = Section(
            resets_at=at(bonus.get("BonusStoreRemainingDurationInSeconds")),
            offers=[
                Offer(
                    item=catalog.item(first_reward(b.get("Offer")).get("ItemID")),
                    base_price=((b.get("Offer") or {}).get("Cost") or {}).get(CURRENCY["VP"]),
                    price=(b.get("DiscountCosts") or {}).get(CURRENCY["VP"]),
                    discount_percent=b.get("DiscountPercent") or 0,
                    seen=bool(b.get("IsSeen")),
                )
                for b in bonus.get("BonusStoreOffers") or []
            ],
        )

    featured = raw.get("FeaturedBundle") or {}
    bundle_list = featured.get("Bundles") or ([featured["Bundle"]] if featured.get("Bundle") else [])
    bundles = []
    for b in bundle_list:
        meta = catalog.bundles.get(b.get("DataAssetID"))
        items = b.get("Items") or []
        bundles.append(BundleOffer(
            uuid=b.get("DataAssetID") or "",
            name=meta.name if meta else "Featured bundle",
            icon=meta.icon if meta else None,
            resets_at=at(b.get("DurationRemainingInSeconds", featured.get("BundleRemainingDurationInSeconds"))),
            price=(b.get("TotalDiscountedCost") or {}).get(CURRENCY["VP"]) or sum(i.get("DiscountedPrice") or 0 for i in items),
            base_price=(b.get("TotalBaseCost") or {}).get(CURRENCY["VP"]) or sum(i.get("BasePrice") or 0 for i in items),
            wholesale_only=bool(b.get("WholesaleOnly")),
            offers=[
                Offer(
                    item=catalog.item((i.get("Item") or {}).get("ItemID")),
                    quantity=(i.get("Item") or {}).get("Amount") or (i.get("Item") or {}).get("Quantity") or 1,
                    price=i.get("DiscountedPrice"),
                    base_price=i.get("BasePrice"),
                    promo=bool(i.get("IsPromoItem")),
                )
                for i in items
            ],
        ))

    return Shop(fetched_at=now, daily=daily, accessories=accessories, night_market=night_market, bundles=bundles)


def is_wishlisted(item: Item, wishlist: list[str]) -> bool:
    return item.kind != "unknown" and item.key in wishlist


def wishlist_hits(shop: Shop, wishlist: list[str]) -> dict[str, list[Offer]]:
    """Wishlisted offers in the daily shop, accessory store and night market."""
    def match(section: Section | None) -> list[Offer]:
        return [o for o in section.offers if is_wishlisted(o.item, wishlist)] if section else []
    return {"daily": match(shop.daily), "accessories": match(shop.accessories), "night_market": match(shop.night_market)}


def offer_key(uuids) -> str:
    """Order-independent identity of a set of offers."""
    return ",".join(sorted(uuids))


# Reset times are derived from "seconds remaining" at fetch time, so they drift by
# the request latency; round them so the same rotation always gets the same key.
RESET_ROUNDING = 5 * 60


def rotation_key(section: Section) -> str:
    """One rotation of a section: when it resets, plus what's in it."""
    resets = "" if section.resets_at is None else str(round(section.resets_at / RESET_ROUNDING) * RESET_ROUNDING)
    return f"{resets}|{offer_key(o.item.uuid for o in section.offers)}"


def section_keys(shop: Shop) -> dict[str, str | None]:
    """Keys that change when a section rotates. Daily/accessories/night market are keyed
    by rotation, so they're re-posted every day/week even if the items repeat. Bundles
    have no fixed rotation, so they're keyed by which bundles are featured."""
    return {
        "daily": rotation_key(shop.daily),
        "accessories": rotation_key(shop.accessories),
        "night_market": rotation_key(shop.night_market) if shop.night_market else None,
        "bundles": offer_key(b.uuid for b in shop.bundles) if shop.bundles else None,
    }


MAX_DELAY = 24 * 60 * 60


def next_reset(shop: Shop) -> float:
    """Earliest upcoming reset of any section, capped at a day out."""
    times = [shop.daily.resets_at, shop.accessories.resets_at, shop.fetched_at + MAX_DELAY]
    if shop.night_market:
        times.append(shop.night_market.resets_at)
    times += [b.resets_at for b in shop.bundles]
    return min(t for t in times if t is not None)

"""Static item data from valorant-api.com (third party, no auth).

Resolves the UUIDs in a storefront response to names, pictures and rarity, and
powers wishlist search.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field, replace

import aiohttp

log = logging.getLogger("storefront.catalog")

CURRENCY = {
    "VP": "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741",
    "KC": "85ca954a-41f2-ce94-9b45-8ca3dd39a00d",
    "RAD": "e59aa87c-4cbf-517a-5983-6e81511be9b7",
}

KIND_LABEL = {
    "skin": "Skin",
    "buddy": "Gun buddy",
    "spray": "Spray",
    "card": "Player card",
    "title": "Player title",
    "flex": "Flex",
}

REFRESH = 12 * 60 * 60


@dataclass(frozen=True)
class Tier:
    name: str
    color: int | None
    icon: str | None


@dataclass(frozen=True)
class Item:
    uuid: str
    kind: str
    name: str
    icon: str | None
    tier: Tier | None = None
    # Player cards: large (in-game banner), wide (scoreboard) and small (icon) art.
    views: tuple[str, ...] = ()
    wishlistable: bool = True
    # Set on level entries (skins, buddies and sprays are sold by level UUID):
    # the top-level item, which is what the wishlist stores.
    parent: str | None = None

    @property
    def key(self) -> str:
        return self.parent or self.uuid


@dataclass(frozen=True)
class Bundle:
    uuid: str
    name: str
    icon: str | None


def _tier_color(rgba: str | None) -> int | None:
    return int(rgba[:6], 16) if rgba else None


class Catalog:
    def __init__(self, http: aiohttp.ClientSession):
        self.http = http
        self.items: dict[str, Item] = {}
        self.wishlistable: list[Item] = []
        self.bundles: dict[str, Bundle] = {}
        self.loaded_at = 0.0
        self._lock = asyncio.Lock()
        self._refresh: asyncio.Task | None = None

    async def _get(self, path: str):
        async with self.http.get(f"https://valorant-api.com/v1/{path}", timeout=aiohttp.ClientTimeout(total=60)) as res:
            res.raise_for_status()
            return (await res.json())["data"]

    async def ensure_loaded(self) -> None:
        """Load on first use. Later refreshes run in the background so callers (like
        autocomplete, which must answer within 3 seconds) never wait on them."""
        if self.loaded_at:
            if time.time() - self.loaded_at >= REFRESH and not (self._refresh and not self._refresh.done()):
                self._refresh = asyncio.create_task(self._fetch())
            return
        async with self._lock:
            if not self.loaded_at:
                await self._fetch()

    async def _fetch(self) -> None:
        try:
            self.load(*await asyncio.gather(*(self._get(p) for p in (
                "contenttiers", "weapons/skins", "buddies", "sprays",
                "playercards", "playertitles", "flex", "bundles",
            ))))
            log.info("catalog loaded: %d items, %d wishlistable, %d bundles",
                     len(self.items), len(self.wishlistable), len(self.bundles))
        except Exception as exc:
            if not self.loaded_at:
                raise
            log.warning("catalog refresh failed, using cached data: %s", exc)

    def load(self, tiers, skins, buddies, sprays, cards, titles, flex, bundles) -> None:
        tier_map = {
            t["uuid"]: Tier(name=t["devName"], color=_tier_color(t.get("highlightColor")), icon=t.get("displayIcon"))
            for t in tiers
        }
        items: dict[str, Item] = {}

        def add(item: Item, levels=()) -> None:
            items[item.uuid] = item
            for level in levels:
                if level["uuid"] != item.uuid:
                    items[level["uuid"]] = replace(item, uuid=level["uuid"], parent=item.uuid)

        for s in skins:
            levels = s.get("levels") or []
            add(Item(
                uuid=s["uuid"], kind="skin", name=s["displayName"],
                icon=(levels[0].get("displayIcon") if levels else None) or s.get("displayIcon"),
                tier=tier_map.get(s.get("contentTierUuid")),
                # Defaults and "Random Favorite Skin" have no tier and are never sold.
                wishlistable=bool(s.get("contentTierUuid")),
            ), levels)
        for b in buddies:
            add(Item(uuid=b["uuid"], kind="buddy", name=b["displayName"], icon=b.get("displayIcon")), b.get("levels") or [])
        for s in sprays:
            add(Item(
                uuid=s["uuid"], kind="spray", name=s["displayName"],
                icon=s.get("fullTransparentIcon") or s.get("displayIcon"),
                wishlistable=not s.get("isNullSpray"),
            ), s.get("levels") or [])
        for c in cards:
            add(Item(
                uuid=c["uuid"], kind="card", name=c["displayName"],
                icon=c.get("largeArt") or c.get("displayIcon"),
                views=tuple(v for v in (c.get("largeArt"), c.get("wideArt"), c.get("smallArt")) if v),
            ))
        for t in titles:
            text = t.get("titleText")
            add(Item(uuid=t["uuid"], kind="title", name=text or t["displayName"], icon=None, wishlistable=bool(text)))
        for f in flex:
            add(Item(uuid=f["uuid"], kind="flex", name=f["displayName"], icon=f.get("displayIcon")))

        self.items = items
        self.wishlistable = [i for i in items.values() if i.wishlistable and not i.parent and i.name]
        self.bundles = {b["uuid"]: Bundle(uuid=b["uuid"], name=b["displayName"], icon=b.get("displayIcon")) for b in bundles}
        self.loaded_at = time.time()

    def item(self, uuid: str | None) -> Item:
        found = self.items.get(uuid or "")
        if found:
            return found
        return Item(uuid=uuid or "", kind="unknown", name=f"Unknown item ({(uuid or '?')[:8]})", icon=None, wishlistable=False)

    def search(self, query: str, *, kind: str | None = None, limit: int = 25) -> list[Item]:
        """Prefix matches first, then substring matches, optionally one kind only."""
        q = query.strip().casefold()
        scored = []
        for item in self.wishlistable:
            if kind and item.kind != kind:
                continue
            name = item.name.casefold()
            index = name.find(q) if q else 0
            if index != -1:
                scored.append((0 if index == 0 else 1, name, item))
        scored.sort(key=lambda s: (s[0], s[1]))
        return [s[2] for s in scored[:limit]]

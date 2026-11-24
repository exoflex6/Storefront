"""Static item data from valorant-api.com (third party, no auth).

Resolves the UUIDs in a storefront response to names, pictures and rarity, and
powers wishlist search.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

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

ACCESSORY_KINDS = {"buddy", "spray", "card", "title", "flex"}
# Contracts whose rewards can come back in the accessory store: past battle passes
# ("Season") and event passes ("Event"). Agent contract rewards are always earnable
# from the agent, so they aren't sold.
PASS_TYPES = {"Season", "Event"}
# Riot's store offer list should hold hundreds of skins; anything smaller is a bad response.
MIN_STORE_SKINS = 100


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
    def __init__(self, http: aiohttp.ClientSession, state_path: Path | None = None):
        self.http = http
        self.items: dict[str, Item] = {}
        self.wishlistable: list[Item] = []
        self.bundles: dict[str, Bundle] = {}
        self.loaded_at = 0.0
        # Which items can actually show up in a shop (see can_rotate).
        self.pass_items: set[str] = set()   # accessories from past battle/event passes
        self.contract_skins: set[str] = set()  # skins earned from any contract, never sold
        self.store_skins: set[str] | None = None  # skins in Riot's store offer list
        self.store_skins_at = 0.0
        self.seen: set[str] = set()  # anything actually observed in someone's shop
        self.state_path = state_path
        self._load_state()
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
                "playercards", "playertitles", "flex", "bundles", "contracts",
            ))))
            log.info("catalog loaded: %d items, %d wishlistable, %d bundles",
                     len(self.items), len(self.wishlistable), len(self.bundles))
        except Exception as exc:
            if not self.loaded_at:
                raise
            log.warning("catalog refresh failed, using cached data: %s", exc)

    def load(self, tiers, skins, buddies, sprays, cards, titles, flex, bundles, contracts=()) -> None:
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

        pass_items, contract_skins = set(), set()
        for contract in contracts:
            content = contract.get("content") or {}
            is_pass = content.get("relationType") in PASS_TYPES and "BETA" not in (contract.get("displayName") or "").upper()
            for chapter in content.get("chapters") or []:
                rewards = [level["reward"] for level in chapter.get("levels") or []] + list(chapter.get("freeRewards") or [])
                for reward in rewards:
                    item = items.get(reward.get("uuid") or "")
                    if not item:
                        continue
                    if item.kind == "skin":
                        contract_skins.add(item.key)
                    elif is_pass and item.kind in ACCESSORY_KINDS:
                        pass_items.add(item.key)
        self.pass_items = pass_items
        self.contract_skins = contract_skins
        self.bundles = {b["uuid"]: Bundle(uuid=b["uuid"], name=b["displayName"], icon=b.get("displayIcon")) for b in bundles}
        self.loaded_at = time.time()

    def item(self, uuid: str | None) -> Item:
        found = self.items.get(uuid or "")
        if found:
            return found
        return Item(uuid=uuid or "", kind="unknown", name=f"Unknown item ({(uuid or '?')[:8]})", icon=None, wishlistable=False)

    # --- which items can rotate into a shop -----------------------------------

    def can_rotate(self, item: Item) -> bool:
        """Whether an item can ever show up in the daily shop, night market or accessory store.

        Skins: Riot's store offer list when we have it; otherwise any skin with a rarity
        that isn't a battle pass/agent contract reward. Accessories: rewards from past
        battle passes and event passes. Anything seen in a real shop always counts.
        """
        if item.key in self.seen:
            return True
        if item.kind == "skin":
            if self.store_skins is not None:
                return item.key in self.store_skins
            return item.tier is not None and item.key not in self.contract_skins
        if item.kind in ACCESSORY_KINDS:
            return item.key in self.pass_items
        return False

    def set_store_offers(self, raw: dict) -> int:
        """Record which skins Riot sells, from GET /store/v1/offers. Returns how many."""
        skins = set()
        for offer in raw.get("Offers") or []:
            for reward in offer.get("Rewards") or []:
                item = self.items.get(reward.get("ItemID") or "")
                if item and item.kind == "skin":
                    skins.add(item.key)
        if len(skins) < MIN_STORE_SKINS:
            log.warning("store offer list had only %d skins; ignoring it", len(skins))
            return 0
        self.store_skins = skins
        self.store_skins_at = time.time()
        self._save_state()
        log.info("store offers: %d skins can rotate into the shop", len(skins))
        return len(skins)

    def note_seen(self, items) -> None:
        """Items seen in a real shop can rotate, whatever the lists above say."""
        new = {i.key for i in items if i.kind != "unknown"} - self.seen
        if new:
            self.seen |= new
            self._save_state()

    def _load_state(self) -> None:
        if not self.state_path or not self.state_path.exists():
            return
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("could not read %s (%s); starting fresh", self.state_path.name, exc)
            return
        if state.get("store_skins"):
            self.store_skins = set(state["store_skins"])
            self.store_skins_at = state.get("store_skins_at", 0.0)
        self.seen = set(state.get("seen") or [])

    def _save_state(self) -> None:
        if not self.state_path:
            return
        state = {
            "store_skins": sorted(self.store_skins) if self.store_skins is not None else None,
            "store_skins_at": self.store_skins_at,
            "seen": sorted(self.seen),
        }
        fd, tmp = tempfile.mkstemp(prefix=".rotation-", dir=self.state_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(state, handle)
            os.replace(tmp, self.state_path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def search(self, query: str, *, kind: str | None = None, limit: int = 25) -> list[Item]:
        """Prefix matches first, then substring matches, optionally one kind only.
        Only items that can actually rotate into a shop are offered."""
        q = query.strip().casefold()
        scored = []
        for item in self.wishlistable:
            if kind and item.kind != kind:
                continue
            if not self.can_rotate(item):
                continue
            name = item.name.casefold()
            index = name.find(q) if q else 0
            if index != -1:
                scored.append((0 if index == 0 else 1, name, item))
        scored.sort(key=lambda s: (s[0], s[1]))
        return [s[2] for s in scored[:limit]]

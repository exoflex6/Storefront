"""Discord cards for shop sections, wishlist entries and alerts."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import discord

from catalog import KIND_LABEL, Item
from shop import Offer, Shop, is_wishlisted

log = logging.getLogger("storefront.embeds")

RED = 0xFF4655  # Valorant red
MAX_EMBEDS = 10  # per message, Discord's limit
WISHLISTED = "⭐ On your wishlist"


class Emojis:
    """Optional application emojis (Dev Portal -> Emojis, so they work without a server).

    Names looked up: vp, kc, and the rarity names lowercased (select, deluxe,
    premium, exclusive, ultra). Missing ones fall back to text.
    """

    def __init__(self) -> None:
        self.by_name: dict[str, str] = {}

    async def load(self, client: discord.Client) -> None:
        try:
            emojis = await client.fetch_application_emojis()
            self.by_name = {e.name.lower(): str(e) for e in emojis}
        except discord.HTTPException as exc:
            log.warning("could not load application emojis: %s", exc)

    def get(self, name: str, fallback: str = "") -> str:
        return self.by_name.get(name.lower(), fallback)


def relative(ts: float | None) -> str:
    return f"<t:{int(ts)}:R>" if ts else "at an unknown time"


def price(amount: int | None, currency: str) -> str:
    return "?" if amount is None else f"{currency} {amount:,}"


def item_embed(item: Item, emojis: Emojis, lines: list[str | None]) -> discord.Embed:
    tier_emoji = emojis.get(item.tier.name) if item.tier else ""
    embed = discord.Embed(
        title=f"{tier_emoji + ' ' if tier_emoji else ''}{item.name}"[:256],
        description="\n".join(line for line in lines if line) or None,
        color=(item.tier.color if item.tier and item.tier.color is not None else RED),
    )
    if item.icon:
        embed.set_thumbnail(url=item.icon)
    return embed


def header(title: str, description: str) -> discord.Embed:
    return discord.Embed(title=title, description=description, color=RED)


def daily_embeds(shop: Shop, emojis: Emojis, wishlist: list[str], title: str = "Daily shop") -> list[discord.Embed]:
    vp = emojis.get("vp", "VP")
    return [header(title, f"Resets {relative(shop.daily.resets_at)}")] + [
        item_embed(o.item, emojis, [price(o.price, vp), WISHLISTED if is_wishlisted(o.item, wishlist) else None])
        for o in shop.daily.offers
    ]


def accessory_embeds(shop: Shop, emojis: Emojis, wishlist: list[str]) -> list[discord.Embed]:
    kc = emojis.get("kc", "KC")
    return [header("Accessory store", f"Rotates {relative(shop.accessories.resets_at)}")] + [
        item_embed(o.item, emojis, [
            KIND_LABEL.get(o.item.kind, "Item"),
            f"x{o.quantity}" if o.quantity > 1 else None,
            price(o.price, kc),
            WISHLISTED if is_wishlisted(o.item, wishlist) else None,
        ])
        for o in shop.accessories.offers
    ]


def night_market_line(o: Offer, vp: str) -> str:
    return f"~~{price(o.base_price, vp)}~~ → **{price(o.price, vp)}** (-{o.discount_percent}%)"


def night_market_embeds(shop: Shop, emojis: Emojis, wishlist: list[str]) -> list[discord.Embed]:
    if not shop.night_market:
        return [header("Night market", "The night market isn't open right now.")]
    vp = emojis.get("vp", "VP")
    return [header("Night market", f"Closes {relative(shop.night_market.resets_at)}")] + [
        item_embed(o.item, emojis, [
            None if o.seen else "*Not revealed in-game yet*",
            night_market_line(o, vp),
            WISHLISTED if is_wishlisted(o.item, wishlist) else None,
        ])
        for o in shop.night_market.offers
    ]


def bundle_embeds(shop: Shop, emojis: Emojis) -> list[discord.Embed]:
    if not shop.bundles:
        return [header("Featured bundle", "No featured bundle right now.")]
    vp = emojis.get("vp", "VP")
    embeds = []
    for bundle in shop.bundles[:MAX_EMBEDS]:
        lines = []
        for o in bundle.offers:
            qty = f" x{o.quantity}" if o.quantity > 1 else ""
            cost = "free" if o.price == 0 else price(o.price, vp)
            lines.append(f"• {o.item.name}{qty} - {cost}")
        if bundle.base_price and bundle.base_price != bundle.price:
            total = f"~~{price(bundle.base_price, vp)}~~ → **{price(bundle.price, vp)}**"
        else:
            total = f"**{price(bundle.price, vp)}**"
        count = len(bundle.offers)
        description = "\n".join([
            f"{total}{' (bundle only)' if bundle.wholesale_only else ''} · {count} item{'s' if count != 1 else ''}",
            f"Leaves {relative(bundle.resets_at)}",
            "",
            *lines,
        ])[:4096]
        embed = discord.Embed(title=bundle.name, description=description, color=RED)
        if bundle.icon:
            embed.set_image(url=bundle.icon)
        embeds.append(embed)
    return embeds


def with_gallery(embed: discord.Embed, item: Item) -> list[discord.Embed]:
    """Discord merges embeds sharing a `url` into one card with an image gallery (up to 4).

    Player cards use it to show all three art views at once. Keep the group together when paging.
    """
    if len(item.views) < 2:
        return [embed]
    embed.url = item.views[0]
    embed.set_thumbnail(url=None)
    embed.set_image(url=item.views[0])
    return [embed] + [discord.Embed(url=item.views[0]).set_image(url=view) for view in item.views[1:4]]


def wishlist_item_embeds(item: Item, emojis: Emojis, *, large: bool = False, note: str | None = None) -> list[discord.Embed]:
    """A wishlist entry. `large` shows the picture full-width (and a player card's three views)."""
    embed = item_embed(item, emojis, [KIND_LABEL.get(item.kind, "Item"), note])
    if not large:
        return [embed]
    if len(item.views) > 1:
        return with_gallery(embed, item)
    if item.icon:
        embed.set_thumbnail(url=None)
        embed.set_image(url=item.icon)
    return [embed]


@dataclass
class Group:
    """Embeds that must stay in one message, tagged with the shop section they belong to."""
    section: str
    embeds: list[discord.Embed]


def alert_groups(hits: dict[str, list[Offer]], emojis: Emojis) -> list[Group]:
    vp, kc = emojis.get("vp", "VP"), emojis.get("kc", "KC")
    groups = []
    for o in hits["daily"]:
        groups.append(Group("daily", [item_embed(o.item, emojis, ["⭐ Wishlisted skin in your **daily shop**", price(o.price, vp)])]))
    for o in hits["accessories"]:
        label = KIND_LABEL.get(o.item.kind, "item").lower()
        groups.append(Group("accessories", with_gallery(item_embed(o.item, emojis, [
            f"⭐ Wishlisted {label} in your **accessory store**",
            f"x{o.quantity}" if o.quantity > 1 else None,
            price(o.price, kc),
        ]), o.item)))
    for o in hits["night_market"]:
        groups.append(Group("night_market", [item_embed(o.item, emojis, [
            "⭐ Wishlisted skin in your **night market**", night_market_line(o, vp),
        ])]))
    return groups


@dataclass
class Page:
    embeds: list[discord.Embed]
    sections: set[str]


def paginate(groups: list[Group], limit: int = MAX_EMBEDS) -> list[Page]:
    """Pack groups into messages of at most `limit` embeds without splitting a group."""
    pages: list[Page] = []
    for group in groups:
        if not pages or len(pages[-1].embeds) + len(group.embeds) > limit:
            pages.append(Page([], set()))
        pages[-1].embeds.extend(group.embeds[:limit])
        pages[-1].sections.add(group.section)
    return pages


def section_embeds(name: str, shop: Shop, emojis: Emojis, wishlist: list[str], *, auto: bool = False) -> list[discord.Embed]:
    if name == "daily":
        return daily_embeds(shop, emojis, wishlist, "Today's shop" if auto else "Daily shop")
    if name == "accessories":
        return accessory_embeds(shop, emojis, wishlist)
    if name == "night_market":
        return night_market_embeds(shop, emojis, wishlist)
    return bundle_embeds(shop, emojis)

"""Per-user shop fetching, caching, and the post-reset DM scheduler."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

import discord

from catalog import Catalog
from embeds import Emojis, Group, alert_groups, paginate, section_embeds
from riot import AuthError, MaintenanceError, RiotAccount, RiotAPI
from shop import SECTIONS, Shop, next_reset, parse_storefront, section_keys, wishlist_hits
from users import UserStore, new_user

log = logging.getLogger("storefront.service")

# Serve repeated /shop calls from cache, but never past a reset.
CACHE_TTL = 5 * 60
# Wait a bit after a reset before fetching so the new shop is live.
RESET_GRACE = 90
RETRY = 60 * 60
MIN_DELAY = 60
MAX_DELAY = 24 * 60 * 60
# Space out scheduled checks so many users resetting at once don't hammer Riot's login.
CHECK_SPACING = 2
TICK = 30
# Riot's list of sellable skins changes only when new skins ship.
OFFERS_TTL = 24 * 60 * 60

REFRESH_HINT = "Run `/register` to add a fresh cookie."

Notify = Callable[[int, dict], Awaitable[None]]


def describe_error(err: Exception, action: str = "fetch your shop") -> str:
    """User-facing one-liner. Never includes tokens or cookies."""
    if isinstance(err, AuthError) and err.dead:
        return f"Your Riot login expired ({err}). {REFRESH_HINT}"
    if isinstance(err, AuthError):
        return f"Riot login failed, probably temporarily: {err}"
    if isinstance(err, MaintenanceError):
        return "Valorant is in scheduled maintenance - try again later."
    return f"Couldn't {action}: {err}"


class ShopService:
    def __init__(self, api: RiotAPI, catalog: Catalog, users: UserStore, emojis: Emojis, notify: Notify):
        self.api = api
        self.catalog = catalog
        self.users = users
        self.emojis = emojis
        self.notify = notify
        self.accounts: dict[str, RiotAccount] = {}
        self.cache: dict[str, Shop] = {}
        self.next_check: dict[str, float] = {}
        self._offers_task: asyncio.Task | None = None

    # --- accounts ------------------------------------------------------------

    def account(self, user_id: int | str) -> RiotAccount:
        uid = str(user_id)
        if uid not in self.accounts:
            user = self.users.get(uid)

            def save_cookies(cookies: dict[str, str], uid=uid) -> None:
                # The user may have unregistered while a login was in flight.
                current = self.users.get(uid)
                if current is not None:
                    current["cookies"] = cookies
                    self.users.save()

            self.accounts[uid] = RiotAccount(self.api, dict(user["cookies"]), save_cookies)
        return self.accounts[uid]

    async def register(self, user_id: int | str, cookies: dict[str, str]) -> tuple[dict, Shop | None]:
        """Validate the cookies with Riot and store the user. Keeps an existing wishlist and settings.

        Baselines the current rotation so registering doesn't trigger a burst of DMs; the
        first automatic post comes at the next reset.
        """
        uid = str(user_id)
        session = await self.api.login(cookies)
        previous = self.users.get(uid)
        user = new_user(session.cookies)
        if previous:
            user.update(wishlist=previous["wishlist"], auto_post=previous["auto_post"], registered_at=previous["registered_at"])
        user.update(riot_name=session.name, puuid=session.puuid, shard=session.shard)
        self.users.put(uid, user)

        self.cache.pop(uid, None)
        self.accounts.pop(uid, None)
        account = self.account(uid)
        account.session = session

        shop = None
        try:
            shop = await self.get(uid, fresh=True)
            keys = section_keys(shop)
            user["last_posted"].update({name: key for name, key in keys.items() if key is not None})
            self.users.save()
            self.next_check[uid] = next_reset(shop) + RESET_GRACE
        except Exception as exc:
            # Registered anyway; the scheduler will pick the shop up.
            log.warning("user %s registered but first shop fetch failed: %s", uid, exc)
            self.next_check[uid] = time.time() + MIN_DELAY
        log.info("user %s registered (shard %s)", uid, session.shard)
        return user, shop

    def unregister(self, user_id: int | str) -> bool:
        uid = str(user_id)
        for table in (self.accounts, self.cache, self.next_check):
            table.pop(uid, None)
        removed = self.users.remove(uid)
        if removed:
            log.info("user %s unregistered", uid)
        return removed

    # --- fetching ------------------------------------------------------------

    async def get(self, user_id: int | str, *, fresh: bool = False) -> Shop:
        uid = str(user_id)
        now = time.time()
        cached = self.cache.get(uid)
        if not fresh and cached and now - cached.fetched_at < CACHE_TTL and now < next_reset(cached):
            return cached
        try:
            raw, _ = await asyncio.gather(self.account(uid).storefront(), self.catalog.ensure_loaded())
        except AuthError as exc:
            if exc.dead:
                await self._cookie_died(uid, exc)
            raise
        shop = parse_storefront(raw, self.catalog)
        self.cache[uid] = shop
        self.catalog.note_seen(o.item for section in (shop.daily, shop.accessories, shop.night_market)
                               if section for o in section.offers)
        if time.time() - self.catalog.store_skins_at > OFFERS_TTL and not (self._offers_task and not self._offers_task.done()):
            self._offers_task = asyncio.create_task(self._refresh_offers(uid))
        user = self.users.get(uid)
        if user and user["auth_dead"]:
            user["auth_dead"] = False
            self.users.save()
        return shop

    async def _refresh_offers(self, uid: str) -> None:
        """Refresh which skins can rotate into shops, using this user's (already live) login."""
        try:
            self.catalog.set_store_offers(await self.account(uid).offers())
        except Exception as exc:
            log.warning("could not refresh the store offer list: %s", exc)

    async def _cookie_died(self, uid: str, err: AuthError) -> None:
        """Tell the user once per dead cookie rather than failing silently."""
        user = self.users.get(uid)
        if not user or user["auth_dead"]:
            return
        log.warning("user %s: cookie dead: %s", uid, err)
        user["auth_dead"] = True
        self.users.save()
        self.accounts.pop(uid, None)
        try:
            await self.notify(int(uid), {"content": f"⚠️ {describe_error(err)}"})
        except Exception as exc:
            log.warning("user %s: could not DM about the dead cookie: %s", uid, exc)

    # --- scheduler -----------------------------------------------------------

    async def check(self, user_id: int | str) -> float:
        """Fetch a user's shop, DM what reset, and return when to check them next."""
        uid = str(user_id)
        try:
            shop = await self.get(uid, fresh=True)
            await self.post_updates(uid, shop)
            delay = next_reset(shop) - time.time() + RESET_GRACE
        except Exception as exc:
            log.warning("user %s: check failed, retrying in 1h: %s", uid, exc)
            delay = RETRY
        return time.time() + min(max(delay, MIN_DELAY), MAX_DELAY)

    async def post_updates(self, uid: str, shop: Shop) -> None:
        user = self.users.get(uid)
        if not user:
            return
        last, auto_post, wishlist = user["last_posted"], user["auto_post"], user["wishlist"]
        changed = {name: key for name, key in section_keys(shop).items() if key is not None and key != last[name]}
        if not changed:
            return

        hits = {name: offers if name in changed else [] for name, offers in wishlist_hits(shop, wishlist).items()}
        alerts = paginate(alert_groups(hits, self.emojis))
        posts = paginate([
            Group(name, section_embeds(name, shop, self.emojis, wishlist, auto=True))
            for name in SECTIONS if name in changed and auto_post.get(name)
        ])
        messages = [
            ({"content": "🔔 Wishlist alert!", "embeds": p.embeds} if i == 0 else {"embeds": p.embeds}, p.sections)
            for i, p in enumerate(alerts)
        ] + [({"embeds": p.embeds}, p.sections) for p in posts]

        # A section counts as posted once the last message carrying it went out. If a DM
        # fails part-way, only the sections not yet delivered are retried next time.
        last_message = {section: i for i, (_, sections) in enumerate(messages) for section in sections}

        def mark(names) -> None:
            names = list(names)
            if names:
                last.update({name: changed[name] for name in names})
                self.users.save()

        mark(name for name in changed if name not in last_message)
        for i, (payload, _) in enumerate(messages):
            try:
                await self.notify(int(uid), payload)
            except discord.Forbidden as exc:
                # The user can't be DMed (no shared server, DMs closed). Retrying won't help,
                # so drop this rotation rather than re-logging into Riot every hour.
                log.warning("user %s: DMs refused (%s); skipping this rotation", uid, exc)
                mark(changed)
                return
            mark(name for name in changed if last_message.get(name) == i)

    async def run_scheduler(self) -> None:
        log.info("scheduler started")
        while True:
            now = time.time()
            due = [
                uid for uid in self.users.ids()
                if not self.users.get(uid)["auth_dead"] and self.next_check.get(uid, 0) <= now
            ]
            for uid in due:
                if self.users.get(uid) is None:
                    continue  # unregistered meanwhile
                self.next_check[uid] = await self.check(uid)
                log.info("user %s: next check %s", uid, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.next_check[uid])))
                await asyncio.sleep(CHECK_SPACING)
            await asyncio.sleep(TICK)

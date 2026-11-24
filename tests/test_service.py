import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import discord

from embeds import Emojis
from riot import AuthError, Session
from service import ShopService
from users import UserStore
from tests.fixtures import BUDDY, SKIN_B, fake_catalog, storefront

ALL_ON = {"daily": True, "accessories": True, "night_market": True, "bundles": True}
ALL_OFF = {"daily": False, "accessories": False, "night_market": False, "bundles": False}


class FakeAPI:
    """Stands in for RiotAPI. Each ssid maps to a storefront; 'dead' cookies are rejected."""

    def __init__(self):
        self.shops = {}  # ssid -> raw storefront
        self.dead = set()
        self.logins = 0

    async def login(self, cookies):
        self.logins += 1
        ssid = cookies.get("ssid")
        if not ssid or ssid in self.dead:
            raise AuthError("cookie rejected - Riot asked to log in again", dead=True)
        return Session(
            access_token=f"at-{ssid}", id_token="id", expires_at=time.time() + 3600,
            entitlements_token="ent", puuid=f"puuid-{ssid}", name=f"{ssid}#NA1", shard="na",
            cookies={**cookies, "ssid": ssid},  # Riot would rotate it; keep it simple
        )

    async def offers(self, session):
        return {"Offers": []}

    async def storefront(self, session):
        ssid = session.access_token.removeprefix("at-")
        if ssid in self.dead:
            return 400, {"errorCode": "BAD_CLAIMS"}, ""
        return 200, self.shops[ssid], ""


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.store = UserStore(Path(self.dir.name) / "users.json")
        self.api = FakeAPI()
        self.catalog = fake_catalog()
        self.catalog.ensure_loaded = mock.AsyncMock()
        self.sent = []  # (user_id, payload)

        async def notify(user_id, payload):
            self.sent.append((user_id, payload))

        self.service = ShopService(self.api, self.catalog, self.store, Emojis(), notify)

    async def register(self, uid, ssid, *, auto_post=ALL_OFF, wishlist=(), night_market=True):
        self.api.shops[ssid] = storefront(night_market=night_market)
        user, shop = await self.service.register(uid, {"ssid": ssid})
        user["auto_post"] = dict(auto_post)
        user["wishlist"] = list(wishlist)
        self.store.save()
        return user, shop

    def next_day(self, ssid, days=1):
        self.api.shops[ssid] = json.loads(json.dumps(self.api.shops[ssid]))
        self.api.shops[ssid]["SkinsPanelLayout"]["SingleItemOffersRemainingDurationInSeconds"] += 86400 * days

    async def test_register_stores_user_and_sends_nothing_yet(self):
        user, shop = await self.register(1, "alice", auto_post=ALL_ON)
        self.assertEqual(user["riot_name"], "alice#NA1")
        self.assertIsNotNone(shop)
        await self.service.check(1)  # same rotation as at registration
        self.assertEqual(self.sent, [])

    async def test_bad_cookie_is_not_registered(self):
        self.api.dead.add("bad")
        with self.assertRaises(AuthError):
            await self.service.register(1, {"ssid": "bad"})
        self.assertIsNone(self.store.get(1))

    async def test_users_get_their_own_shop_and_dms(self):
        await self.register(1, "alice", auto_post=ALL_OFF, wishlist=[SKIN_B["uuid"]])
        await self.register(2, "bob", auto_post=ALL_OFF, wishlist=[])
        self.next_day("alice")
        self.next_day("bob")
        await self.service.check(1)
        await self.service.check(2)
        self.assertEqual([uid for uid, _ in self.sent], [1])  # only alice had a wishlist hit
        self.assertEqual(self.sent[0][1]["content"], "🔔 Wishlist alert!")

    async def test_daily_auto_post_every_day_even_if_repeated(self):
        await self.register(1, "alice", auto_post={**ALL_OFF, "daily": True})
        for _ in range(2):
            self.next_day("alice")
            await self.service.check(1)
        titles = [[e.title for e in p["embeds"]] for _, p in self.sent]
        self.assertEqual(titles, [["Today's shop", "Prime Vandal", "Reaver Sheriff"]] * 2)

    async def test_wishlisted_accessory_alerts_once_per_rotation(self):
        await self.register(1, "alice", wishlist=[BUDDY["uuid"]], night_market=False)
        self.next_day("alice")
        await self.service.check(1)
        self.assertEqual(self.sent, [])  # accessories didn't rotate
        self.api.shops["alice"]["AccessoryStore"]["AccessoryStoreRemainingDurationInSeconds"] += 7 * 86400
        await self.service.check(1)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("accessory store", self.sent[0][1]["embeds"][0].description)

    async def test_partial_dm_failure_only_retries_undelivered(self):
        await self.register(1, "alice", auto_post=ALL_ON, wishlist=[SKIN_B["uuid"]])
        self.next_day("alice")
        calls = 0

        async def flaky(uid, payload):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise discord.HTTPException(SimpleNamespace(status=500, reason="boom"), "boom")
            self.sent.append((uid, payload))

        self.service.notify = flaky
        await self.service.check(1)
        self.assertEqual(len(self.sent), 1)  # the alert got out, the full shop didn't
        self.assertNotEqual(self.store.get(1)["last_posted"]["daily"], None)  # baseline from registration
        before = self.store.get(1)["last_posted"]["daily"]

        self.service.notify = lambda uid, p: self._record(uid, p)
        await self.service.check(1)
        self.assertEqual(len(self.sent), 3)  # alert again (daily wasn't complete) + full shop
        self.assertNotEqual(self.store.get(1)["last_posted"]["daily"], before)

    async def _record(self, uid, payload):
        self.sent.append((uid, payload))

    async def test_closed_dms_skip_the_rotation(self):
        await self.register(1, "alice", auto_post=ALL_ON)
        self.next_day("alice")

        async def closed(uid, payload):
            raise discord.Forbidden(SimpleNamespace(status=403, reason="Forbidden"), "Cannot send messages to this user")

        self.service.notify = closed
        await self.service.check(1)
        self.service.notify = self._record
        await self.service.check(1)
        self.assertEqual(self.sent, [])  # not retried every hour

    async def test_dead_cookie_dms_once_and_pauses_checks(self):
        await self.register(1, "alice")
        self.api.dead.add("alice")
        self.service.accounts["1"].session = None  # force a re-login
        await self.service.check(1)
        await self.service.check(1)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("/register", self.sent[0][1]["content"])
        self.assertTrue(self.store.get(1)["auth_dead"])

        # Re-registering with a working cookie clears it and keeps the wishlist.
        self.store.get(1)["wishlist"] = [BUDDY["uuid"]]
        self.api.shops["alice2"] = storefront()
        user, _ = await self.service.register(1, {"ssid": "alice2"})
        self.assertFalse(user["auth_dead"])
        self.assertEqual(user["wishlist"], [BUDDY["uuid"]])

    async def test_unregister_deletes_everything(self):
        await self.register(1, "alice")
        self.assertTrue(self.service.unregister(1))
        self.assertIsNone(self.store.get(1))
        self.assertNotIn("1", self.service.accounts)
        self.assertNotIn("1", json.loads((Path(self.dir.name) / "users.json").read_text()))

    async def test_users_file_is_private(self):
        await self.register(1, "alice")
        mode = stat.S_IMODE(os.stat(Path(self.dir.name) / "users.json").st_mode)
        self.assertEqual(mode, 0o600)


class RegistrationGate(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        import bot as bot_module
        self.bot_module = bot_module
        bot_module.bot.store = UserStore(Path(self.dir.name) / "users.json")

    def interaction(self, user_id):
        sent = []

        async def send_message(content=None, **kwargs):
            sent.append((content, kwargs))

        return SimpleNamespace(user=SimpleNamespace(id=user_id), response=SimpleNamespace(send_message=send_message)), sent

    async def test_unregistered_users_are_asked_to_register(self):
        interaction, sent = self.interaction(42)
        self.assertIsNone(await self.bot_module.require_user(interaction))
        content, kwargs = sent[0]
        self.assertIn("add your Riot account", content)
        self.assertTrue(kwargs["ephemeral"])
        self.assertIsInstance(kwargs["view"], self.bot_module.RegisterView)

    async def test_registered_users_pass(self):
        self.bot_module.bot.store.put(42, {"cookies": {"ssid": "x"}, "wishlist": []})
        interaction, sent = self.interaction(42)
        self.assertIsNotNone(await self.bot_module.require_user(interaction))
        self.assertEqual(sent, [])


if __name__ == "__main__":
    unittest.main()

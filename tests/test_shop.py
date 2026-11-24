import base64
import json
import unittest
import unittest.mock

from embeds import Emojis, Group, alert_groups, paginate, section_embeds, wishlist_item_embeds
from riot import CLIENT_PLATFORM, merge_set_cookies, parse_cookie_input, parse_reauth_location, region_to_shard
from shop import SECTIONS, next_reset, parse_storefront, rotation_key, wishlist_hits
import tempfile
from pathlib import Path

from tests.fixtures import AGENT_SPRAY, BP_SKIN, BUDDY, CARD, PASS_SPRAY, SKIN_A, SKIN_B, SKIN_NM, fake_catalog, storefront

NOW = 1_800_000_000


class RiotParsing(unittest.TestCase):
    def test_cookie_input_forms(self):
        self.assertEqual(parse_cookie_input("  abc.def  "), {"ssid": "abc.def"})
        self.assertEqual(parse_cookie_input("ssid=abc"), {"ssid": "abc"})
        self.assertEqual(parse_cookie_input("Cookie: ssid=abc; clid=uw1; tdid=x=y"), {"ssid": "abc", "clid": "uw1", "tdid": "x=y"})
        self.assertEqual(parse_cookie_input(""), {})

    def test_set_cookie_rotation(self):
        jar = merge_set_cookies({"ssid": "old", "sub": "1"}, ["ssid=new; Path=/; Secure", "sub=; Max-Age=0"])
        self.assertEqual(jar, {"ssid": "new"})

    def test_reauth_redirects(self):
        ok = parse_reauth_location("https://playvalorant.com/opt_in#access_token=AT&id_token=IT&expires_in=3600")
        self.assertEqual((ok["access_token"], ok["id_token"]), ("AT", "IT"))
        self.assertIsNone(parse_reauth_location("https://authenticate.riotgames.com/login?x=1"))
        self.assertIsNone(parse_reauth_location(None))

    def test_shards(self):
        self.assertEqual(region_to_shard("latam"), "na")
        self.assertEqual(region_to_shard("br"), "na")
        self.assertEqual(region_to_shard("eu"), "eu")

    def test_client_platform_blob(self):
        decoded = json.loads(base64.b64decode(CLIENT_PLATFORM))
        self.assertEqual(decoded["platformType"], "PC")


class Parsing(unittest.TestCase):
    def setUp(self):
        self.catalog = fake_catalog()

    def test_sections(self):
        shop = parse_storefront(storefront(), self.catalog, NOW)
        self.assertEqual([o.item.name for o in shop.daily.offers], [SKIN_A["name"], SKIN_B["name"]])
        self.assertEqual(shop.daily.offers[0].price, 1775)
        self.assertEqual(shop.daily.resets_at, NOW + 3600)
        self.assertEqual(shop.accessories.offers[0].item.key, BUDDY["uuid"])
        self.assertEqual(shop.accessories.offers[0].price, 4000)
        nm = shop.night_market.offers[0]
        self.assertEqual((nm.price, nm.base_price, nm.discount_percent, nm.seen), (1242, 1775, 30, False))
        self.assertEqual((shop.bundles[0].name, shop.bundles[0].price), ("Prime 2.0", 1500))
        self.assertIsNone(parse_storefront(storefront(night_market=False), self.catalog, NOW).night_market)

    def test_unknown_items_dont_crash(self):
        raw = storefront()
        raw["SkinsPanelLayout"]["SingleItemStoreOffers"][0]["Rewards"][0]["ItemID"] = "nope-1234"
        shop = parse_storefront(raw, self.catalog, NOW)
        self.assertTrue(shop.daily.offers[0].item.name.startswith("Unknown item"))
        self.assertEqual(wishlist_hits(shop, ["nope-1234"])["daily"], [])

    def test_wishlist_hits_use_parent_item(self):
        shop = parse_storefront(storefront(), self.catalog, NOW)
        hits = wishlist_hits(shop, [SKIN_B["uuid"], BUDDY["uuid"], SKIN_NM["uuid"]])
        self.assertEqual([len(hits[s]) for s in ("daily", "accessories", "night_market")], [1, 1, 1])

    def test_rotation_key_ignores_latency_but_not_resets(self):
        a = parse_storefront(storefront(), self.catalog, NOW)
        b = parse_storefront(storefront(), self.catalog, NOW + 2)  # same rotation, fetched 2s later
        raw = storefront()
        raw["SkinsPanelLayout"]["SingleItemOffersRemainingDurationInSeconds"] += 86400
        c = parse_storefront(raw, self.catalog, NOW)
        self.assertEqual(rotation_key(a.daily), rotation_key(b.daily))
        self.assertNotEqual(rotation_key(a.daily), rotation_key(c.daily))

    def test_next_reset_is_earliest(self):
        shop = parse_storefront(storefront(), self.catalog, NOW)
        self.assertEqual(next_reset(shop), NOW + 3600)

    def test_catalog(self):
        self.assertEqual(self.catalog.item(SKIN_A["level"]).key, SKIN_A["uuid"])
        names = [i.name for i in self.catalog.search("prime")]
        self.assertEqual(names[:2], ["Prime Vandal", "Primed"])  # prefix matches first
        self.assertNotIn("Standard Vandal", [i.name for i in self.catalog.search("vandal")])  # unsellable
        self.assertEqual([i.kind for i in self.catalog.search("oni", kind="card")], ["card"])


class Rotation(unittest.TestCase):
    def setUp(self):
        self.catalog = fake_catalog()
        self.can = lambda uuid: self.catalog.can_rotate(self.catalog.item(uuid))

    def test_without_riot_offer_list(self):
        self.assertTrue(self.can(SKIN_A["uuid"]))  # store skin with a rarity
        self.assertFalse(self.can(BP_SKIN["uuid"]))  # battle pass reward
        self.assertFalse(self.can("default"))  # default skin
        self.assertTrue(self.can(BUDDY["uuid"]))  # past battle pass accessory
        self.assertTrue(self.can(PASS_SPRAY["uuid"]))  # event pass accessory
        self.assertFalse(self.can(AGENT_SPRAY["uuid"]))  # agent contract: always earnable, never sold

    def test_riot_offer_list_decides_skins(self):
        offers = {"Offers": [{"Rewards": [{"ItemID": SKIN_A["level"]}]}]}
        with unittest.mock.patch("catalog.MIN_STORE_SKINS", 1):
            self.assertEqual(self.catalog.set_store_offers(offers), 1)
        self.assertTrue(self.can(SKIN_A["uuid"]))
        self.assertFalse(self.can(SKIN_B["uuid"]))  # not sold anymore

    def test_tiny_offer_list_is_ignored(self):
        self.assertEqual(self.catalog.set_store_offers({"Offers": [{"Rewards": [{"ItemID": SKIN_A["level"]}]}]}), 0)
        self.assertIsNone(self.catalog.store_skins)

    def test_seen_in_a_real_shop_always_counts(self):
        self.catalog.note_seen([self.catalog.item(AGENT_SPRAY["level"])])
        self.assertTrue(self.can(AGENT_SPRAY["uuid"]))

    def test_search_only_offers_rotatable_items(self):
        names = [i.name for i in self.catalog.search("")]
        self.assertNotIn(BP_SKIN["name"], names)
        self.assertNotIn(AGENT_SPRAY["name"], names)
        self.assertIn(PASS_SPRAY["name"], names)

    def test_state_survives_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "rotation.json"
            first = fake_catalog(path)
            first.note_seen([first.item(AGENT_SPRAY["level"])])
            with unittest.mock.patch("catalog.MIN_STORE_SKINS", 1):
                first.set_store_offers({"Offers": [{"Rewards": [{"ItemID": SKIN_A["level"]}]}]})
            second = fake_catalog(path)
            self.assertEqual(second.store_skins, {SKIN_A["uuid"]})
            self.assertIn(AGENT_SPRAY["uuid"], second.seen)


class Embeds(unittest.TestCase):
    def setUp(self):
        self.catalog = fake_catalog()
        self.shop = parse_storefront(storefront(), self.catalog, NOW)

    def test_every_view_fits_discord_limits(self):
        for name in SECTIONS:
            embeds = section_embeds(name, self.shop, Emojis(), [SKIN_A["uuid"]])
            self.assertLessEqual(len(embeds), 10)
            for e in embeds:
                self.assertLessEqual(len(e), 6000)
                e.to_dict()
        daily = section_embeds("daily", self.shop, Emojis(), [SKIN_A["uuid"]])
        self.assertIn("⭐", daily[1].description)

    def test_player_card_gallery(self):
        embeds = wishlist_item_embeds(self.catalog.item(CARD["uuid"]), Emojis(), large=True)
        self.assertEqual(len(embeds), 3)
        self.assertEqual({e.url for e in embeds}, {"https://img/c-large.png"})

    def test_paginate_keeps_groups_and_tracks_sections(self):
        groups = [Group("daily", [object()] * 5), Group("accessories", [object()] * 5), Group("bundles", [object()] * 2)]
        pages = paginate(groups)
        self.assertEqual([len(p.embeds) for p in pages], [10, 2])
        self.assertEqual([p.sections for p in pages], [{"daily", "accessories"}, {"bundles"}])

    def test_alert_groups(self):
        hits = wishlist_hits(self.shop, [SKIN_B["uuid"], BUDDY["uuid"]])
        groups = alert_groups(hits, Emojis())
        self.assertEqual([g.section for g in groups], ["daily", "accessories"])
        self.assertIn("accessory store", groups[1].embeds[0].description)


if __name__ == "__main__":
    unittest.main()

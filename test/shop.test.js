import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStorefront, findWishlistHits, offerKey } from "../src/shop.js";
import { nextReset } from "../src/shops.js";
import { fakeCatalog, storefront, SKIN_A, SKIN_B, SKIN_NM } from "./fixtures.js";

const NOW = 1_800_000_000_000;

test("parses daily shop with prices and reset from remaining duration", () => {
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    assert.equal(shop.daily.resetsAt, NOW + 3600 * 1000);
    assert.deepEqual(shop.daily.items.map((i) => [i.name, i.price, i.skinUuid]), [
        ["Prime Vandal", 1775, SKIN_A.skin],
        ["Reaver Sheriff", 1275, SKIN_B.skin],
    ]);
});

test("parses accessory store in Kingdom Credits", () => {
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    assert.equal(shop.accessories.resetsAt, NOW + 7200 * 1000);
    assert.deepEqual(shop.accessories.items.map((i) => [i.kind, i.name, i.price]), [["buddy", "Lucky Buddy", 3000]]);
});

test("parses night market discounts, and null when closed", () => {
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    const [item] = shop.nightMarket.items;
    assert.equal(item.name, "Oni Phantom");
    assert.equal(item.basePrice, 1775);
    assert.equal(item.price, 1065);
    assert.equal(item.discountPercent, 40);
    assert.equal(item.seen, false);
    assert.equal(parseStorefront(storefront({ nightMarket: false }), fakeCatalog(), NOW).nightMarket, null);
});

test("parses featured bundle totals and items", () => {
    const [bundle] = parseStorefront(storefront(), fakeCatalog(), NOW).bundles;
    assert.equal(bundle.name, "Prime 2.0");
    assert.equal(bundle.price, 1450);
    assert.equal(bundle.basePrice, 2650);
    assert.equal(bundle.resetsAt, NOW + 86400 * 3 * 1000);
    assert.deepEqual(bundle.items.map((i) => [i.name, i.price]), [["Prime Vandal", 1450], ["Lucky Buddy", 0]]);
});

test("unknown item UUIDs don't throw", () => {
    const raw = storefront();
    raw.SkinsPanelLayout.SingleItemStoreOffers[0].Rewards[0].ItemID = "brand-new-skin";
    const shop = parseStorefront(raw, fakeCatalog(), NOW);
    assert.equal(shop.daily.items[0].kind, "unknown");
    assert.equal(shop.daily.items[0].skinUuid, null);
});

test("wishlist hits match by skin UUID in daily shop and night market", () => {
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    const hits = findWishlistHits(shop, [SKIN_B.skin, SKIN_NM.skin, "not-in-shop"]);
    assert.deepEqual(hits.daily.map((i) => i.name), ["Reaver Sheriff"]);
    assert.deepEqual(hits.nightMarket.map((i) => i.name), ["Oni Phantom"]);
});

test("offerKey is order-independent", () => {
    assert.equal(offerKey([{ uuid: "b" }, { uuid: "a" }]), offerKey([{ uuid: "a" }, { uuid: "b" }]));
});

test("nextReset picks the earliest of daily and night market", () => {
    assert.equal(nextReset(parseStorefront(storefront(), fakeCatalog(), NOW)), NOW + 600 * 1000);
    assert.equal(nextReset(parseStorefront(storefront({ nightMarket: false }), fakeCatalog(), NOW)), NOW + 3600 * 1000);
});

test("every embed view builds within Discord limits", async () => {
    const { Emojis, dailyEmbeds, accessoryEmbeds, nightMarketEmbeds, bundleEmbeds } = await import("../src/discord/embeds.js");
    const emojis = new Emojis();
    for (const shop of [parseStorefront(storefront(), fakeCatalog(), NOW), parseStorefront(storefront({ nightMarket: false }), fakeCatalog(), NOW)]) {
        for (const view of [dailyEmbeds, accessoryEmbeds, nightMarketEmbeds, bundleEmbeds]) {
            const embeds = view(shop, emojis, {}).map((e) => e.toJSON());
            assert.ok(embeds.length >= 1 && embeds.length <= 10);
        }
    }
});

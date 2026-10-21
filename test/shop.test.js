import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStorefront, findWishlistHits, offerKey } from "../src/shop.js";
import { nextReset } from "../src/shops.js";
import { fakeCatalog, storefront, SKIN_A, SKIN_B, SKIN_NM, BUDDY } from "./fixtures.js";

const NOW = 1_800_000_000_000;

test("parses daily shop with prices and reset from remaining duration", () => {
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    assert.equal(shop.daily.resetsAt, NOW + 3600 * 1000);
    assert.deepEqual(shop.daily.items.map((i) => [i.name, i.price, i.key]), [
        ["Prime Vandal", 1775, SKIN_A.skin],
        ["Reaver Sheriff", 1275, SKIN_B.skin],
    ]);
});

test("parses accessory store in Kingdom Credits", () => {
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    assert.equal(shop.accessories.resetsAt, NOW + 7200 * 1000);
    assert.deepEqual(shop.accessories.items.map((i) => [i.kind, i.name, i.price, i.key]), [["buddy", "Lucky Buddy", 3000, BUDDY.buddy]]);
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
    assert.equal(shop.daily.items[0].key, null);
});

test("wishlist hits match by item UUID in daily shop, accessories and night market", () => {
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    const hits = findWishlistHits(shop, [SKIN_B.skin, SKIN_NM.skin, BUDDY.buddy, "not-in-shop"]);
    assert.deepEqual(hits.daily.map((i) => i.name), ["Reaver Sheriff"]);
    assert.deepEqual(hits.accessories.map((i) => i.name), ["Lucky Buddy"]);
    assert.deepEqual(hits.nightMarket.map((i) => i.name), ["Oni Phantom"]);
});

test("offerKey is order-independent", () => {
    assert.equal(offerKey([{ uuid: "b" }, { uuid: "a" }]), offerKey([{ uuid: "a" }, { uuid: "b" }]));
});

test("nextReset picks the earliest of daily and night market", () => {
    assert.equal(nextReset(parseStorefront(storefront(), fakeCatalog(), NOW)), NOW + 600 * 1000);
    assert.equal(nextReset(parseStorefront(storefront({ nightMarket: false }), fakeCatalog(), NOW)), NOW + 3600 * 1000);
    const raw = storefront({ nightMarket: false });
    raw.AccessoryStore.AccessoryStoreRemainingDurationInSeconds = 60;
    assert.equal(nextReset(parseStorefront(raw, fakeCatalog(), NOW)), NOW + 60 * 1000);
});

test("every embed view builds within Discord limits", async () => {
    const { Emojis, dailyEmbeds, accessoryEmbeds, nightMarketEmbeds, bundleEmbeds, alertEmbeds } = await import("../src/discord/embeds.js");
    const emojis = new Emojis();
    for (const shop of [parseStorefront(storefront(), fakeCatalog(), NOW), parseStorefront(storefront({ nightMarket: false }), fakeCatalog(), NOW)]) {
        for (const view of [dailyEmbeds, accessoryEmbeds, nightMarketEmbeds, bundleEmbeds]) {
            const embeds = view(shop, emojis, {}).map((e) => e.toJSON());
            assert.ok(embeds.length >= 1 && embeds.length <= 10);
        }
    }
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    const pages = alertEmbeds(findWishlistHits(shop, [SKIN_A.skin, BUDDY.buddy, SKIN_NM.skin]), emojis);
    assert.equal(pages.length, 1);
    const alerts = pages[0].map((e) => e.toJSON());
    assert.equal(alerts.length, 3);
    assert.ok(alerts.every((e) => e.thumbnail?.url));
});

test("wishlist cards show the item picture, full-width when large", async () => {
    const { Emojis, wishlistItemEmbeds } = await import("../src/discord/embeds.js");
    const item = fakeCatalog().item(SKIN_A.skin);
    const [small] = wishlistItemEmbeds(item, new Emojis()).map((e) => e.toJSON());
    assert.equal(small.thumbnail.url, item.icon);
    const large = wishlistItemEmbeds(item, new Emojis(), { large: true }).map((e) => e.toJSON());
    assert.equal(large.length, 1);
    assert.equal(large[0].image.url, item.icon);
    assert.equal(large[0].thumbnail, undefined);
    // Titles have no picture; the card still builds.
    assert.ok(wishlistItemEmbeds({ uuid: "t", kind: "title", name: "Tiger", icon: null }, new Emojis())[0].toJSON().title);
});

const PLAYER_CARD = {
    uuid: "card-1",
    kind: "card",
    name: "Oni Card",
    icon: "https://img/large.png",
    views: ["https://img/large.png", "https://img/wide.png", "https://img/small.png"],
};

test("player card preview is a gallery of all three art views", async () => {
    const { Emojis, wishlistItemEmbeds } = await import("../src/discord/embeds.js");
    const embeds = wishlistItemEmbeds(PLAYER_CARD, new Emojis(), { large: true }).map((e) => e.toJSON());
    assert.deepEqual(embeds.map((e) => e.image.url), PLAYER_CARD.views);
    // Discord only merges embeds into one gallery when they share a url.
    assert.ok(embeds.every((e) => e.url === PLAYER_CARD.views[0]));
    assert.equal(embeds[0].title, "Oni Card");
    assert.equal(embeds[0].thumbnail, undefined);
    // The compact list view stays a single thumbnail card.
    assert.equal(wishlistItemEmbeds(PLAYER_CARD, new Emojis()).length, 1);
});

test("alert pages keep a player card's gallery together", async () => {
    const { Emojis, alertEmbeds } = await import("../src/discord/embeds.js");
    const skin = fakeCatalog().item(SKIN_A.skin);
    const hits = {
        daily: Array(8).fill(skin),
        accessories: [{ ...PLAYER_CARD, quantity: 1, price: 2000 }],
        nightMarket: [],
    };
    const pages = alertEmbeds(hits, new Emojis()).map((page) => page.map((e) => e.toJSON()));
    assert.deepEqual(pages.map((p) => p.length), [8, 3]);
    assert.ok(pages[1].every((e) => e.url === PLAYER_CARD.views[0]));
    assert.match(pages[1][0].description, /accessory store/);
});

test("/store groups every section into messages of at most 10 embeds", async () => {
    const { createHandlers } = await import("../src/discord/commands.js");
    const { Emojis } = await import("../src/discord/embeds.js");
    const shop = parseStorefront(storefront(), fakeCatalog(), NOW);
    const calls = [];
    const interaction = {
        user: { id: "owner" },
        commandName: "store",
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        options: { getBoolean: () => null },
        deferReply: async (o) => calls.push(["defer", o]),
        editReply: async (o) => calls.push(["edit", o]),
        followUp: async (o) => calls.push(["followUp", o]),
    };
    const handle = createHandlers({
        store: { state: { wishlist: [] } },
        shops: { get: async () => shop },
        catalog: fakeCatalog(),
        emojis: new Emojis(),
        ownerId: "owner",
    });
    await handle(interaction);
    const messages = calls.filter(([kind]) => kind !== "defer").map(([, o]) => o.embeds.map((e) => e.toJSON().title));
    // All four sections (8 embeds) fit one message; larger shops spill into follow-ups.
    assert.deepEqual(messages, [
        ["Daily shop", "Prime Vandal", "Reaver Sheriff", "Accessory store", "Lucky Buddy", "Night market", "Oni Phantom", "Prime 2.0"],
    ]);
    assert.ok(calls.every(([kind, o]) => kind === "edit" || o.flags)); // private by default
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShopService, pageGroups } from "../src/shops.js";
import { Store } from "../src/store.js";
import { offerKey } from "../src/shop.js";
import { AuthError } from "../src/riot/auth.js";
import { Emojis } from "../src/discord/embeds.js";
import { fakeCatalog, storefront, SKIN_B, SKIN_NM, BUDDY } from "./fixtures.js";

const ALL_OFF = { daily: false, accessories: false, nightMarket: false, bundles: false };

const setup = ({ storefrontImpl = async () => storefront(), autoPost = ALL_OFF } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storefront-test-"));
    const store = new Store(dir);
    store.update((s) => { s.autoPost = { ...autoPost }; });
    const sent = [];
    const catalog = { ...fakeCatalog(), ensureLoaded: async () => {} };
    const service = new ShopService({
        riot: { storefront: storefrontImpl },
        catalog,
        store,
        emojis: new Emojis(),
        notify: async (msg) => { sent.push(msg); },
    });
    return { service, store, sent, dir };
};

test("alerts once per new shop for wishlisted skins", async (t) => {
    const { service, store, sent } = setup();
    t.after(() => service.stop());
    store.update((s) => { s.wishlist = [SKIN_B.skin, SKIN_NM.skin]; });

    await service.start();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].embeds.length, 2); // one daily hit, one night market hit

    await service.start(); // same shop again (e.g. restart) -> no duplicate DM
    assert.equal(sent.length, 1);
});

test("accessory wishlist hits alert once per rotation", async (t) => {
    let raw = storefront({ nightMarket: false });
    const { service, store, sent } = setup({ storefrontImpl: async () => raw });
    t.after(() => service.stop());
    store.update((s) => { s.wishlist = [BUDDY.buddy]; });

    await service.start();
    assert.equal(sent.length, 1);
    assert.match(sent[0].embeds[0].toJSON().description, /accessory store/);

    // New daily shop, same accessories -> no repeat accessory alert.
    raw = storefront({ nightMarket: false });
    raw.SkinsPanelLayout.SingleItemStoreOffers.pop();
    await service.start();
    assert.equal(sent.length, 1);
});

test("wishlist hits re-alert every new day/week even if the shop repeats", async (t) => {
    let raw = storefront({ nightMarket: false });
    const { service, store, sent } = setup({ storefrontImpl: async () => raw });
    t.after(() => service.stop());
    store.update((s) => { s.wishlist = [SKIN_B.skin, BUDDY.buddy]; });

    await service.start();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].embeds.length, 2);

    // Next day, identical daily shop: alert on the daily hit again, not the accessory.
    raw = structuredClone(raw);
    raw.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds += 86400;
    await service.start();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].embeds.length, 1);
    assert.doesNotMatch(sent[1].embeds[0].toJSON().description, /accessory store/);

    // Next week, identical accessories: the accessory hit alerts again.
    raw = structuredClone(raw);
    raw.AccessoryStore.AccessoryStoreRemainingDurationInSeconds += 7 * 86400;
    await service.start();
    assert.equal(sent.length, 3);
    assert.match(sent[2].embeds[0].toJSON().description, /accessory store/);
});

test("auto-post sends the daily shop every day, even when it repeats", async (t) => {
    let raw = storefront({ nightMarket: false });
    const { service, sent } = setup({ storefrontImpl: async () => raw, autoPost: { ...ALL_OFF, daily: true } });
    t.after(() => service.stop());
    await service.start();
    raw = structuredClone(raw);
    raw.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds += 86400;
    await service.start();
    assert.deepEqual(sent.map(titles), [
        ["Today's shop", "Prime Vandal", "Reaver Sheriff"],
        ["Today's shop", "Prime Vandal", "Reaver Sheriff"],
    ]);
});

test("state saved with plain offer keys doesn't re-post after upgrading", async (t) => {
    const { service, store, sent } = setup({ autoPost: { daily: true, accessories: true, nightMarket: true, bundles: true } });
    t.after(() => service.stop());
    const shop = await service.get({ fresh: true });
    store.update((s) => {
        s.lastAlerted = {
            daily: offerKey(shop.daily.items),
            accessories: offerKey(shop.accessories.items),
            nightMarket: offerKey(shop.nightMarket.items),
            bundles: offerKey(shop.bundles),
        };
    });
    await service.start();
    assert.equal(sent.length, 0);
    assert.match(store.state.lastAlerted.daily, /\|/);
});

const titles = (message) => message.embeds.map((e) => e.toJSON().title);

test("auto-post DMs every enabled section, grouped into messages", async (t) => {
    const { service, sent } = setup({ autoPost: { daily: true, accessories: true, nightMarket: true, bundles: true } });
    t.after(() => service.stop());
    await service.start();
    assert.deepEqual(sent.map(titles), [[
        "Today's shop", "Prime Vandal", "Reaver Sheriff",
        "Accessory store", "Lucky Buddy",
        "Night market", "Oni Phantom",
        "Prime 2.0",
    ]]);
});

test("auto-post only re-sends the sections that reset", async (t) => {
    let raw = storefront({ nightMarket: false });
    const { service, sent } = setup({
        storefrontImpl: async () => raw,
        autoPost: { daily: true, accessories: true, nightMarket: true, bundles: true },
    });
    t.after(() => service.stop());
    await service.start();
    assert.equal(sent.length, 1);

    // Next day: new daily shop, accessories and bundle unchanged.
    raw = storefront({ nightMarket: false });
    raw.SkinsPanelLayout.SingleItemStoreOffers.pop();
    await service.start();
    assert.deepEqual(titles(sent[1]), ["Today's shop", "Prime Vandal"]);

    // Accessory rotation: only accessories go out.
    raw = structuredClone(raw);
    raw.AccessoryStore.AccessoryStoreOffers[0].Offer.Rewards[0].ItemID = SKIN_B.level;
    await service.start();
    assert.deepEqual(titles(sent[2]), ["Accessory store", "Reaver Sheriff"]);
    assert.equal(sent.length, 3);
});

test("disabled sections aren't auto-posted, but wishlist alerts still are", async (t) => {
    const { service, store, sent } = setup({ autoPost: { ...ALL_OFF, accessories: true } });
    t.after(() => service.stop());
    store.update((s) => { s.wishlist = [SKIN_B.skin]; });
    await service.start();
    assert.equal(sent[0].content, "🔔 Wishlist alert!");
    assert.deepEqual(titles(sent[1]), ["Accessory store", "Lucky Buddy"]);
    assert.equal(sent.length, 2);
});

test("saved state without autoPost settings gets the defaults (all on)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storefront-test-"));
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ wishlist: ["x"], lastAlerted: { daily: "k" } }));
    const store = new Store(dir);
    assert.deepEqual(store.state.autoPost, { daily: true, accessories: true, nightMarket: true, bundles: true });
    assert.deepEqual(store.state.lastAlerted, { daily: "k", accessories: null, nightMarket: null, bundles: null });
});

test("dead cookie notifies the owner once, and resets after recovery", async (t) => {
    let dead = true;
    const { service, store, sent } = setup({
        storefrontImpl: async () => {
            if (dead) throw new AuthError("ssid cookie rejected (redirected to login)", { dead: true });
            return storefront();
        },
    });
    t.after(() => service.stop());

    await assert.rejects(service.get({ fresh: true }), AuthError);
    await assert.rejects(service.get({ fresh: true }), AuthError);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Riot login expired/);
    assert.equal(store.state.authDeadNotified, true);

    dead = false;
    await service.get({ fresh: true });
    assert.equal(store.state.authDeadNotified, false);
});

test("transient auth errors don't notify", async (t) => {
    const { service, sent } = setup({ storefrontImpl: async () => { throw new AuthError("Riot auth rate limited (429)"); } });
    t.after(() => service.stop());
    await assert.rejects(service.get({ fresh: true }), AuthError);
    assert.equal(sent.length, 0);
});

test("state file is private", () => {
    const { store } = setup();
    store.save();
    if (process.platform !== "win32") assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test("a DM that fails part-way only retries the sections that didn't arrive", async (t) => {
    const { service, store, sent } = setup({ autoPost: { daily: true, accessories: true, nightMarket: true, bundles: true } });
    t.after(() => service.stop());
    store.update((s) => { s.wishlist = [SKIN_B.skin]; });

    // Message 1 is the wishlist alert (daily); message 2 the full shop. Fail the second.
    let calls = 0;
    service.notify = async (msg) => {
        calls += 1;
        if (calls === 2) throw new Error("Cannot send messages to this user");
        sent.push(msg);
    };
    await service.start();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, "🔔 Wishlist alert!");
    // Daily was in both messages, so it isn't marked as posted yet; nothing else is either.
    assert.deepEqual(Object.values(store.state.lastAlerted), [null, null, null, null]);

    // Next run: the alert goes again (its section wasn't fully delivered), plus the full shop.
    service.notify = async (msg) => { sent.push(msg); };
    await service.start();
    assert.equal(sent.length, 3);
    assert.ok(Object.values(store.state.lastAlerted).every(Boolean));
});

test("sections fully delivered before a failure aren't sent again", async (t) => {
    const { service, store, sent } = setup({ autoPost: { daily: true, accessories: true, nightMarket: true, bundles: true } });
    t.after(() => service.stop());
    store.update((s) => { s.wishlist = [BUDDY.buddy]; }); // accessory hit only

    // Fail the full-shop message, which comes after the alert.
    let calls = 0;
    service.notify = async (msg) => {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        sent.push(msg);
    };
    await service.start();
    assert.equal(sent.length, 1);
    // Accessories still appear in the failed full-shop message, so they stay pending.
    assert.equal(store.state.lastAlerted.accessories, null);

    // With auto-post off for accessories, its alert alone completes the section.
    store.update((s) => { s.autoPost.accessories = false; });
    calls = 0;
    sent.length = 0;
    await service.start();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, "🔔 Wishlist alert!");
    assert.ok(store.state.lastAlerted.accessories);
    assert.equal(store.state.lastAlerted.daily, null);
});

test("pageGroups records which sections each message carries", () => {
    const group = (section, n) => ({ section, embeds: Array.from({ length: n }, (_, i) => `${section}${i}`) });
    const pages = pageGroups([group("daily", 5), group("accessories", 5), group("bundles", 2)]);
    assert.deepEqual(pages.map((p) => p.embeds.length), [10, 2]);
    assert.deepEqual(pages.map((p) => [...p.sections]), [["daily", "accessories"], ["bundles"]]);
});

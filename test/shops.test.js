import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShopService } from "../src/shops.js";
import { Store } from "../src/store.js";
import { AuthError } from "../src/riot/auth.js";
import { Emojis } from "../src/discord/embeds.js";
import { fakeCatalog, storefront, SKIN_B, SKIN_NM, BUDDY } from "./fixtures.js";

const setup = ({ storefrontImpl = async () => storefront(), dailyDm = false } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storefront-test-"));
    const store = new Store(dir);
    const sent = [];
    const catalog = { ...fakeCatalog(), ensureLoaded: async () => {} };
    const service = new ShopService({
        riot: { storefront: storefrontImpl },
        catalog,
        store,
        emojis: new Emojis(),
        dailyDm,
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

test("daily DM sends the full shop even without wishlist hits", async (t) => {
    const { service, sent } = setup({ dailyDm: true });
    t.after(() => service.stop());
    await service.start();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].embeds.length, 3); // header + 2 skins
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

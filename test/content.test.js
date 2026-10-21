import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/content.js";

// Minimal valorant-api.com payloads, served through a stubbed fetch.
const data = {
    contenttiers: [{ uuid: "tier-p", devName: "Premium", rank: 2, highlightColor: "d1548dff", displayIcon: null }],
    "weapons/skins": [
        { uuid: "skin-1", displayName: "Prime Vandal", contentTierUuid: "tier-p", displayIcon: null, levels: [{ uuid: "skin-1-l1", displayIcon: "https://img/skin.png" }, { uuid: "skin-1-l2", displayIcon: null }] },
        { uuid: "skin-std", displayName: "Standard Vandal", contentTierUuid: null, displayIcon: null, levels: [{ uuid: "skin-std-l1", displayIcon: null }] },
    ],
    buddies: [{ uuid: "buddy-1", displayName: "Prime Buddy", displayIcon: "https://img/buddy.png", levels: [{ uuid: "buddy-1-l1" }] }],
    sprays: [
        { uuid: "spray-1", displayName: "Prime Spray", isNullSpray: false, fullTransparentIcon: "https://img/spray.png", levels: [{ uuid: "spray-1-l1" }] },
        { uuid: "spray-null", displayName: "", isNullSpray: true, levels: [] },
    ],
    playercards: [{ uuid: "card-1", displayName: "Prime Card", largeArt: "https://img/card.png" }],
    playertitles: [{ uuid: "title-1", displayName: "Prime Title", titleText: "Primed" }, { uuid: "title-empty", displayName: null, titleText: null }],
    flex: [{ uuid: "flex-1", displayName: "Prime Totem", displayIcon: null }],
    bundles: [{ uuid: "bundle-1", displayName: "Prime", displayIcon: null }],
};

const loadCatalog = async (t) => {
    mock.method(globalThis, "fetch", async (url) => ({
        ok: true,
        json: async () => ({ data: data[new URL(url).pathname.replace("/v1/", "")] }),
    }));
    t.after(() => mock.restoreAll());
    const catalog = new Catalog();
    await catalog.ensureLoaded();
    return catalog;
};

test("level UUIDs resolve to the parent item's wishlist key", async (t) => {
    const catalog = await loadCatalog(t);
    assert.equal(catalog.wishlistKeyFor("skin-1-l1"), "skin-1");
    assert.equal(catalog.wishlistKeyFor("skin-1-l2"), "skin-1");
    assert.equal(catalog.wishlistKeyFor("buddy-1-l1"), "buddy-1");
    assert.equal(catalog.wishlistKeyFor("spray-1-l1"), "spray-1");
    assert.equal(catalog.wishlistKeyFor("card-1"), "card-1");
    assert.equal(catalog.wishlistKeyFor("nope"), null);
    assert.equal(catalog.item("skin-1-l1").icon, "https://img/skin.png");
});

test("search covers skins and accessories, skipping unsellable items", async (t) => {
    const catalog = await loadCatalog(t);
    assert.deepEqual(catalog.searchWishlistable("prime").map((i) => i.uuid).sort(),
        ["buddy-1", "card-1", "flex-1", "skin-1", "spray-1", "title-1"]); // title text is "Primed"
    assert.deepEqual(catalog.searchWishlistable("prime", { kind: "buddy" }).map((i) => i.uuid), ["buddy-1"]);
    assert.equal(catalog.searchWishlistable("standard").length, 0);
    assert.ok(catalog.wishlistable.every((i) => !i.parentUuid));
});

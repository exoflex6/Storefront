// Static item data from valorant-api.com (third-party, no auth): resolves the
// UUIDs in the storefront response to names, icons and rarity.

export const CURRENCY = {
    VP: "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741",
    KC: "85ca954a-41f2-ce94-9b45-8ca3dd39a00d",
    RAD: "e59aa87c-4cbf-517a-5983-6e81511be9b7",
};

const REFRESH_MS = 12 * 60 * 60 * 1000;

const get = async (path) => {
    const res = await fetch(`https://valorant-api.com/v1/${path}`);
    if (!res.ok) throw new Error(`valorant-api.com /${path} failed (${res.status})`);
    return (await res.json()).data;
};

/** Hex RGBA ("f5955bff") -> Discord int color. */
const tierColor = (rgba) => (rgba ? parseInt(rgba.slice(0, 6), 16) : null);

export class Catalog {
    constructor() {
        /** Any storefront item or level UUID -> {uuid, kind, name, icon, tier?, parentUuid?} */
        this.items = new Map();
        /** Top-level items that can go on the wishlist (keyed by their `uuid`) */
        this.wishlistable = [];
        this.bundles = new Map();
        this.tiers = new Map();
        this.loadedAt = 0;
        this.loading = null;
    }

    async ensureLoaded() {
        if (this.loadedAt && Date.now() - this.loadedAt < REFRESH_MS) return;
        this.loading ??= this.#load().finally(() => { this.loading = null; });
        try {
            await this.loading;
        } catch (err) {
            if (!this.loadedAt) throw err; // keep serving stale data if a refresh fails
            console.warn(`[catalog] refresh failed, using cached data: ${err.message}`);
        }
    }

    async #load() {
        const [tiers, skins, buddies, sprays, cards, titles, flex, bundles] = await Promise.all([
            get("contenttiers"),
            get("weapons/skins"),
            get("buddies"),
            get("sprays"),
            get("playercards"),
            get("playertitles"),
            get("flex"),
            get("bundles"),
        ]);

        const tierMap = new Map(tiers.map((t) => [t.uuid, {
            name: t.devName,
            rank: t.rank,
            color: tierColor(t.highlightColor),
            icon: t.displayIcon,
        }]));

        const items = new Map();
        // Store offers reference an item's level UUID (skins, buddies, sprays); map
        // those back to the parent so the wishlist key is stable across levels.
        const add = (entry, levels = []) => {
            items.set(entry.uuid, entry);
            for (const level of levels) {
                if (level.uuid !== entry.uuid) items.set(level.uuid, { ...entry, parentUuid: entry.uuid });
            }
        };

        for (const skin of skins) {
            add({
                uuid: skin.uuid,
                kind: "skin",
                name: skin.displayName,
                icon: skin.levels[0]?.displayIcon || skin.displayIcon,
                tier: tierMap.get(skin.contentTierUuid) ?? null,
                // Defaults and "Random Favorite Skin" have no tier and are never sold.
                wishlistable: Boolean(skin.contentTierUuid),
            }, skin.levels);
        }
        for (const b of buddies) add({ uuid: b.uuid, kind: "buddy", name: b.displayName, icon: b.displayIcon, wishlistable: true }, b.levels);
        for (const s of sprays) {
            add({ uuid: s.uuid, kind: "spray", name: s.displayName, icon: s.fullTransparentIcon || s.displayIcon, wishlistable: !s.isNullSpray }, s.levels);
        }
        for (const c of cards) {
            add({
                uuid: c.uuid,
                kind: "card",
                name: c.displayName,
                icon: c.largeArt || c.displayIcon,
                // Large (in-game banner), wide (scoreboard) and small (icon) art.
                views: [c.largeArt, c.wideArt, c.smallArt].filter(Boolean),
                wishlistable: true,
            });
        }
        for (const t of titles) {
            add({ uuid: t.uuid, kind: "title", name: t.titleText || t.displayName, icon: null, wishlistable: Boolean(t.titleText) });
        }
        for (const f of flex) add({ uuid: f.uuid, kind: "flex", name: f.displayName, icon: f.displayIcon, wishlistable: true });

        this.tiers = tierMap;
        this.items = items;
        this.wishlistable = [...items.values()].filter((i) => i.wishlistable && !i.parentUuid && i.name);
        this.bundles = new Map(bundles.map((b) => [b.uuid, {
            uuid: b.uuid,
            name: b.displayName,
            icon: b.displayIcon,
        }]));
        this.loadedAt = Date.now();
    }

    item(uuid) {
        return this.items.get(uuid) ?? { uuid, kind: "unknown", name: `Unknown item (${uuid.slice(0, 8)})`, icon: null };
    }

    /** Wishlist key for any item or level UUID (the top-level item's UUID), or null if unknown. */
    wishlistKeyFor(uuid) {
        const item = this.items.get(uuid);
        if (!item) return null;
        return item.parentUuid ?? item.uuid;
    }

    /** Prefix matches first, then substring matches, optionally limited to one kind. */
    searchWishlistable(query, { kind = null, limit = 25 } = {}) {
        const q = query.trim().toLowerCase();
        const results = [];
        for (const item of this.wishlistable) {
            if (kind && item.kind !== kind) continue;
            const name = item.name.toLowerCase();
            const index = q ? name.indexOf(q) : 0;
            if (index === -1) continue;
            results.push({ item, score: index === 0 ? 0 : 1, name });
        }
        results.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
        return results.slice(0, limit).map((r) => r.item);
    }
}

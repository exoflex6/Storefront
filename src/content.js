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
        /** Any storefront item UUID -> {uuid, kind, name, icon, tier?, skinUuid?} */
        this.items = new Map();
        /** Skin UUID -> skin entry (the wishlist is keyed on these) */
        this.skins = new Map();
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
        const [tiers, skins, buddyLevels, sprays, cards, titles, flex, bundles] = await Promise.all([
            get("contenttiers"),
            get("weapons/skins"),
            get("buddies/levels"),
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
        const skinMap = new Map();
        for (const skin of skins) {
            const entry = {
                uuid: skin.uuid,
                kind: "skin",
                name: skin.displayName,
                icon: skin.levels[0]?.displayIcon || skin.displayIcon,
                tier: tierMap.get(skin.contentTierUuid) ?? null,
            };
            skinMap.set(skin.uuid, entry);
            items.set(skin.uuid, entry);
            // Store offers reference the skin's first level; map every level for safety.
            for (const level of skin.levels) items.set(level.uuid, { ...entry, skinUuid: skin.uuid });
        }
        for (const b of buddyLevels) items.set(b.uuid, { uuid: b.uuid, kind: "buddy", name: b.displayName, icon: b.displayIcon });
        for (const s of sprays) items.set(s.uuid, { uuid: s.uuid, kind: "spray", name: s.displayName, icon: s.fullTransparentIcon || s.displayIcon });
        for (const c of cards) items.set(c.uuid, { uuid: c.uuid, kind: "card", name: c.displayName, icon: c.largeArt || c.displayIcon });
        for (const t of titles) items.set(t.uuid, { uuid: t.uuid, kind: "title", name: t.titleText || t.displayName, icon: null });
        for (const f of flex) items.set(f.uuid, { uuid: f.uuid, kind: "flex", name: f.displayName, icon: f.displayIcon });

        this.tiers = tierMap;
        this.items = items;
        this.skins = skinMap;
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

    /** Skin UUID for any skin/level UUID, or null if it isn't a skin. */
    skinUuidFor(uuid) {
        const item = this.items.get(uuid);
        if (!item || item.kind !== "skin") return null;
        return item.skinUuid ?? item.uuid;
    }

    /** Fuzzy-ish skin search for autocomplete. Skips default "Standard" skins. */
    searchSkins(query, limit = 25) {
        const q = query.trim().toLowerCase();
        const results = [];
        for (const skin of this.skins.values()) {
            if (!skin.tier) continue; // defaults and "Random Favorite Skin" have no tier
            const name = skin.name.toLowerCase();
            const index = q ? name.indexOf(q) : 0;
            if (index === -1) continue;
            results.push({ skin, score: index === 0 ? 0 : 1, name });
        }
        results.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
        return results.slice(0, limit).map((r) => r.skin);
    }
}

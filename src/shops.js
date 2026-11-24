import { parseStorefront, findWishlistHits, offerKey } from "./shop.js";
import { AuthError } from "./riot/auth.js";
import { REFRESH_INSTRUCTIONS, describeError } from "./errors.js";
import { accessoryEmbeds, alertGroups, bundleEmbeds, dailyEmbeds, nightMarketEmbeds } from "./discord/embeds.js";

// Serve repeated /shop calls from cache, but never past a reset.
const CACHE_MS = 5 * 60 * 1000;
// Wait a bit after a reset before fetching so the new shop is live.
const RESET_GRACE_MS = 90 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MIN_DELAY_MS = 60 * 1000;
// setTimeout overflows past ~24.8 days.
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

/** Fetches/caches the shop, runs the post-reset checks, and DMs the owner. */
export class ShopService {
    constructor({ riot, catalog, store, emojis, notify }) {
        this.riot = riot;
        this.catalog = catalog;
        this.store = store;
        this.emojis = emojis;
        /** @type {(payload: import("discord.js").MessageCreateOptions) => Promise<void>} */
        this.notify = notify;
        this.cache = null;
        this.timer = null;
    }

    async get({ fresh = false } = {}) {
        const now = Date.now();
        if (!fresh && this.cache && now - this.cache.fetchedAt < CACHE_MS && now < nextReset(this.cache)) return this.cache;

        try {
            const [raw] = await Promise.all([this.riot.storefront(), this.catalog.ensureLoaded()]);
            this.cache = parseStorefront(raw, this.catalog);
        } catch (err) {
            await this.#handleAuthFailure(err);
            throw err;
        }
        if (this.store.state.authDeadNotified) this.store.update((s) => { s.authDeadNotified = false; });
        return this.cache;
    }

    /** Tell the owner once per dead cookie, rather than failing silently. */
    async #handleAuthFailure(err) {
        if (!(err instanceof AuthError && err.dead) || this.store.state.authDeadNotified) return;
        console.error(`[auth] ${err.message}`);
        try {
            await this.notify({ content: `⚠️ ${describeError(err)}` });
            this.store.update((s) => { s.authDeadNotified = true; });
        } catch (dmErr) {
            console.error(`[auth] could not DM owner about dead cookie: ${dmErr.message}. ${REFRESH_INSTRUCTIONS}`);
        }
    }

    /** Check now, then re-arm for the next daily/night-market reset. */
    async start() {
        clearTimeout(this.timer);
        let delay = RETRY_MS;
        try {
            const shop = await this.get({ fresh: true });
            await this.#checkAndAlert(shop);
            delay = nextReset(shop) - Date.now() + RESET_GRACE_MS;
        } catch (err) {
            console.error(`[scheduler] check failed, retrying in 1h: ${err.message}`);
        }
        delay = Math.min(Math.max(delay, MIN_DELAY_MS), MAX_DELAY_MS);
        console.log(`[scheduler] next check at ${new Date(Date.now() + delay).toISOString()}`);
        this.timer = setTimeout(() => this.start(), delay);
    }

    stop() {
        clearTimeout(this.timer);
    }

    async #checkAndAlert(shop) {
        const { lastAlerted, wishlist, autoPost } = this.store.state;
        const hits = findWishlistHits(shop, wishlist);
        // The daily shop, accessories and night market are keyed by rotation, so they're
        // posted (and wishlist hits re-alerted) every day / every week even if the items repeat.
        // Bundles have no fixed rotation, so they're posted whenever they change.
        const keys = {
            daily: rotationKey(shop.daily),
            accessories: rotationKey(shop.accessories),
            nightMarket: shop.nightMarket ? rotationKey(shop.nightMarket) : null,
            bundles: shop.bundles.length ? offerKey(shop.bundles) : null,
        };

        // Only post sections that reset since the last check.
        const changed = {};
        const migrated = {};
        for (const [name, key] of Object.entries(keys)) {
            if (key !== null && key !== lastAlerted[name]) {
                // State saved before rotation keys stored just the offer key: adopt the new key quietly.
                if (name !== "bundles" && lastAlerted[name] === key.split("|")[1]) migrated[name] = key;
                else changed[name] = key;
            }
            if (!(name in changed) && name in hits) hits[name] = [];
        }
        if (Object.keys(migrated).length) this.store.update((s) => { Object.assign(s.lastAlerted, migrated); });
        if (!Object.keys(changed).length) return;

        const fullSections = {
            daily: () => dailyEmbeds(shop, this.emojis, { header: "Today's shop", wishlist }),
            accessories: () => accessoryEmbeds(shop, this.emojis, { wishlist }),
            nightMarket: () => nightMarketEmbeds(shop, this.emojis, { wishlist }),
            bundles: () => bundleEmbeds(shop, this.emojis),
        };
        const alerts = pageGroups(alertGroups(hits, this.emojis));
        const posts = pageGroups(Object.keys(fullSections)
            .filter((name) => name in changed && autoPost[name])
            .map((name) => ({ section: name, embeds: fullSections[name]() })));
        const messages = [
            ...alerts.map((page, i) => ({ ...page, payload: i === 0 ? { content: "🔔 Wishlist alert!", embeds: page.embeds } : { embeds: page.embeds } })),
            ...posts.map((page) => ({ ...page, payload: { embeds: page.embeds } })),
        ];

        // A section counts as posted once the last message carrying it went out. If a DM
        // fails part-way, only the sections not yet delivered are retried next run, so
        // messages that already arrived aren't sent twice.
        const lastMessage = {};
        messages.forEach((message, i) => { for (const section of message.sections) lastMessage[section] = i; });
        const markPosted = (names) => {
            if (!names.length) return;
            this.store.update((s) => { for (const name of names) s.lastAlerted[name] = changed[name]; });
        };
        markPosted(Object.keys(changed).filter((name) => !(name in lastMessage)));
        for (const [i, message] of messages.entries()) {
            await this.notify(message.payload);
            markPosted(Object.keys(changed).filter((name) => lastMessage[name] === i));
        }
    }
}

/**
 * Page tagged embed groups ({section, embeds}) into messages of at most `max` embeds
 * without splitting a group, keeping track of which sections each message carries.
 */
export const pageGroups = (groups, max = 10) => {
    const pages = [];
    let page = null;
    for (const group of groups) {
        if (!page || (page.embeds.length && page.embeds.length + group.embeds.length > max)) {
            page = { embeds: [], sections: new Set() };
            pages.push(page);
        }
        page.embeds.push(...group.embeds.slice(0, max));
        page.sections.add(group.section);
    }
    return pages;
};

/** Earliest upcoming reset of any section (daily shop, accessories, night market, bundles). */
export const nextReset = (shop) => Math.min(
    shop.daily.resetsAt ?? Infinity,
    shop.accessories.resetsAt ?? Infinity,
    shop.nightMarket?.resetsAt ?? Infinity,
    ...shop.bundles.map((bundle) => bundle.resetsAt ?? Infinity),
    shop.fetchedAt + MAX_DELAY_MS,
);

// Reset times are derived from "seconds remaining" at fetch time, so they drift by the request latency.
const RESET_ROUNDING_MS = 5 * 60 * 1000;

/** Identifies one rotation of a section: when it resets, plus what's in it. */
export const rotationKey = (section) => {
    const resetsAt = section.resetsAt == null ? "" : Math.round(section.resetsAt / RESET_ROUNDING_MS) * RESET_ROUNDING_MS;
    return `${resetsAt}|${offerKey(section.items)}`;
};

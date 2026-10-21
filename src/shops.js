import { parseStorefront, findWishlistHits, offerKey } from "./shop.js";
import { AuthError } from "./riot/auth.js";
import { REFRESH_INSTRUCTIONS, describeError } from "./errors.js";
import { accessoryEmbeds, alertEmbeds, bundleEmbeds, dailyEmbeds, nightMarketEmbeds, pageEmbeds } from "./discord/embeds.js";

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
        const sections = {
            daily: shop.daily.items,
            accessories: shop.accessories.items,
            nightMarket: shop.nightMarket?.items ?? null,
            bundles: shop.bundles.length ? shop.bundles : null,
        };

        // Only post sections whose offers changed since the last check.
        const changed = {};
        for (const [name, items] of Object.entries(sections)) {
            const key = items ? offerKey(items) : null;
            if (key !== null && key !== lastAlerted[name]) changed[name] = key;
            else if (name in hits) hits[name] = [];
        }
        if (!Object.keys(changed).length) return;

        const messages = [];
        if (hits.daily.length || hits.accessories.length || hits.nightMarket.length) {
            alertEmbeds(hits, this.emojis).forEach((embeds, i) => {
                messages.push(i === 0 ? { content: "🔔 Wishlist alert!", embeds } : { embeds });
            });
        }

        const fullSections = {
            daily: () => dailyEmbeds(shop, this.emojis, { header: "Today's shop", wishlist }),
            accessories: () => accessoryEmbeds(shop, this.emojis, { wishlist }),
            nightMarket: () => nightMarketEmbeds(shop, this.emojis, { wishlist }),
            bundles: () => bundleEmbeds(shop, this.emojis),
        };
        const posts = Object.keys(fullSections)
            .filter((name) => name in changed && autoPost[name])
            .map((name) => fullSections[name]());
        for (const embeds of pageEmbeds(posts)) messages.push({ embeds });

        for (const message of messages) await this.notify(message);
        // Only mark as posted once the DMs went out, so a failed DM is retried next run.
        this.store.update((s) => { Object.assign(s.lastAlerted, changed); });
    }
}

/** Earliest upcoming reset of any section (daily shop, accessories, night market, bundles). */
export const nextReset = (shop) => Math.min(
    shop.daily.resetsAt ?? Infinity,
    shop.accessories.resetsAt ?? Infinity,
    shop.nightMarket?.resetsAt ?? Infinity,
    ...shop.bundles.map((bundle) => bundle.resetsAt ?? Infinity),
    shop.fetchedAt + MAX_DELAY_MS,
);

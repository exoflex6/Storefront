import { EmbedBuilder } from "discord.js";
import { isWishlisted } from "../shop.js";

const FALLBACK_COLOR = 0xff4655; // Valorant red

/**
 * Optional application emojis (uploaded under Dev Portal -> Emojis, so they work
 * without a guild). Names looked up: vp, kc, and the tier devNames lowercased
 * (select, deluxe, premium, exclusive, ultra). Missing ones fall back to text.
 */
export class Emojis {
    constructor() {
        this.byName = new Map();
    }

    async load(application) {
        try {
            const emojis = await application.emojis.fetch();
            this.byName = new Map(emojis.map((e) => [e.name.toLowerCase(), e.toString()]));
        } catch (err) {
            console.warn(`[emojis] could not load application emojis: ${err.message}`);
        }
    }

    get(name, fallback = "") {
        return this.byName.get(name.toLowerCase()) ?? fallback;
    }
}

const relative = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : "unknown");
const price = (amount, currency) => (amount == null ? "?" : `${currency} ${amount.toLocaleString("en-US")}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const itemEmbed = (item, emojis, lines) => {
    const tierEmoji = item.tier ? emojis.get(item.tier.name) : "";
    const embed = new EmbedBuilder()
        .setTitle(`${tierEmoji ? `${tierEmoji} ` : ""}${item.name}`.slice(0, 256))
        .setDescription(lines.filter(Boolean).join("\n"))
        .setColor(item.tier?.color ?? FALLBACK_COLOR);
    if (item.icon) embed.setThumbnail(item.icon);
    return embed;
};

const WISHLISTED = "⭐ On your wishlist";

export const dailyEmbeds = (shop, emojis, { header = "Daily shop", wishlist = [] } = {}) => {
    const vp = emojis.get("vp", "VP");
    return [
        new EmbedBuilder()
            .setTitle(header)
            .setDescription(`Resets ${relative(shop.daily.resetsAt)}`)
            .setColor(FALLBACK_COLOR),
        ...shop.daily.items.map((item) => itemEmbed(item, emojis, [
            price(item.price, vp),
            isWishlisted(item, wishlist) ? WISHLISTED : null,
        ])),
    ];
};

const KIND_LABEL = { buddy: "Gun buddy", spray: "Spray", card: "Player card", title: "Player title", flex: "Flex", skin: "Skin" };

export const accessoryEmbeds = (shop, emojis, { wishlist = [] } = {}) => {
    const kc = emojis.get("kc", "KC");
    return [
        new EmbedBuilder()
            .setTitle("Accessory store")
            .setDescription(`Rotates ${relative(shop.accessories.resetsAt)}`)
            .setColor(FALLBACK_COLOR),
        ...shop.accessories.items.map((item) => itemEmbed(item, emojis, [
            KIND_LABEL[item.kind] ?? "Item",
            item.quantity > 1 ? `x${item.quantity}` : null,
            price(item.price, kc),
            isWishlisted(item, wishlist) ? WISHLISTED : null,
        ])),
    ];
};

export const nightMarketEmbeds = (shop, emojis, { wishlist = [] } = {}) => {
    if (!shop.nightMarket) {
        return [new EmbedBuilder().setTitle("Night market").setDescription("The night market isn't open right now.").setColor(FALLBACK_COLOR)];
    }
    const vp = emojis.get("vp", "VP");
    return [
        new EmbedBuilder()
            .setTitle("Night market")
            .setDescription(`Closes ${relative(shop.nightMarket.resetsAt)}`)
            .setColor(FALLBACK_COLOR),
        ...shop.nightMarket.items.map((item) => itemEmbed(item, emojis, [
            item.seen ? null : "*Not revealed in-game yet*",
            `~~${price(item.basePrice, vp)}~~ → **${price(item.price, vp)}** (-${item.discountPercent}%)`,
            isWishlisted(item, wishlist) ? WISHLISTED : null,
        ])),
    ];
};

export const bundleEmbeds = (shop, emojis) => {
    if (!shop.bundles.length) {
        return [new EmbedBuilder().setTitle("Featured bundle").setDescription("No featured bundle right now.").setColor(FALLBACK_COLOR)];
    }
    const vp = emojis.get("vp", "VP");
    return shop.bundles.slice(0, 10).map((bundle) => {
        const lines = bundle.items.map((item) => {
            const qty = item.quantity > 1 ? ` x${item.quantity}` : "";
            const cost = item.price === 0 ? "free" : price(item.price, vp);
            return `• ${item.name}${qty} - ${cost}`;
        });
        const total = bundle.basePrice && bundle.basePrice !== bundle.price
            ? `~~${price(bundle.basePrice, vp)}~~ → **${price(bundle.price, vp)}**`
            : `**${price(bundle.price, vp)}**`;
        const embed = new EmbedBuilder()
            .setTitle(bundle.name)
            .setDescription([
                `${total}${bundle.wholesaleOnly ? " (bundle only)" : ""} · ${plural(bundle.items.length, "item")}`,
                `Leaves ${relative(bundle.resetsAt)}`,
                "",
                ...lines,
            ].join("\n").slice(0, 4096))
            .setColor(FALLBACK_COLOR);
        if (bundle.icon) embed.setImage(bundle.icon);
        return embed;
    });
};

export const alertEmbeds = (hits, emojis) => {
    const vp = emojis.get("vp", "VP");
    const kc = emojis.get("kc", "KC");
    const embeds = [];
    for (const item of hits.daily) {
        embeds.push(itemEmbed(item, emojis, ["⭐ Wishlisted skin in your **daily shop**", price(item.price, vp)]));
    }
    for (const item of hits.accessories) {
        embeds.push(itemEmbed(item, emojis, [
            `⭐ Wishlisted ${(KIND_LABEL[item.kind] ?? "item").toLowerCase()} in your **accessory store**`,
            item.quantity > 1 ? `x${item.quantity}` : null,
            price(item.price, kc),
        ]));
    }
    for (const item of hits.nightMarket) {
        embeds.push(itemEmbed(item, emojis, [
            "⭐ Wishlisted skin in your **night market**",
            `~~${price(item.basePrice, vp)}~~ → **${price(item.price, vp)}** (-${item.discountPercent}%)`,
        ]));
    }
    return embeds.slice(0, 10);
};

/** Card for a wishlist entry. `large` shows the picture full-width (used when adding). */
export const wishlistItemEmbed = (item, emojis, { large = false, note = null } = {}) => {
    const embed = itemEmbed(item, emojis, [KIND_LABEL[item.kind] ?? "Item", note]);
    if (large && item.icon) embed.setThumbnail(null).setImage(item.icon);
    return embed;
};

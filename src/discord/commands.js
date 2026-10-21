import {
    ApplicationIntegrationType,
    InteractionContextType,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { accessoryEmbeds, bundleEmbeds, dailyEmbeds, nightMarketEmbeds, pageEmbeds, wishlistItemEmbeds } from "./embeds.js";
import { describeError } from "../errors.js";

// Every command must be installable on both guilds and user accounts and usable
// everywhere, or it won't show up for a user install.
const everywhere = (builder) => builder
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);

const shareOption = (builder) => builder.addBooleanOption((o) => o
    .setName("share")
    .setDescription("Post visibly instead of only to you (default: only you)"));

const KIND_CHOICES = { skin: "Skin", buddy: "Gun buddy", spray: "Spray", card: "Player card", title: "Player title", flex: "Flex" };

const AUTO_POST_SECTIONS = { daily: "Daily shop", accessories: "Accessories", nightMarket: "Night market", bundles: "Bundles" };

const shopCommand = (name, description) => everywhere(shareOption(new SlashCommandBuilder().setName(name).setDescription(description)));

const describeAutoPost = (autoPost) => {
    const on = Object.entries(AUTO_POST_SECTIONS).filter(([key]) => autoPost[key]).map(([, name]) => name.toLowerCase());
    return on.length ? on.join(", ") : "off";
};

export const commandDefinitions = [
    shopCommand("shop", "Your daily Valorant skin shop"),
    shopCommand("accessories", "Your Valorant accessory store"),
    shopCommand("nightmarket", "Your Valorant night market, if it's open"),
    shopCommand("bundle", "The current featured bundle(s)"),
    shopCommand("store", "Everything at once: daily shop, accessories, night market and bundles"),
    everywhere(new SlashCommandBuilder()
        .setName("wishlist")
        .setDescription("Skins and accessories to alert you about")
        .addSubcommand((s) => s.setName("add").setDescription("Add a skin or accessory to your wishlist")
            .addStringOption((o) => o.setName("item").setDescription("Item name").setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName("type").setDescription("Only suggest this kind of item")
                .addChoices(...Object.entries(KIND_CHOICES).map(([value, name]) => ({ name, value })))))
        .addSubcommand((s) => s.setName("remove").setDescription("Remove an item from your wishlist")
            .addStringOption((o) => o.setName("item").setDescription("Item name").setRequired(true).setAutocomplete(true)))
        .addSubcommand((s) => s.setName("list").setDescription("Show your wishlist"))),
    everywhere(new SlashCommandBuilder()
        .setName("autopost")
        .setDescription("DM the full shop whenever it resets (no options: show current settings)")
        .addStringOption((o) => o.setName("section").setDescription("Which part of the shop")
            .addChoices(...Object.entries(AUTO_POST_SECTIONS).map(([value, name]) => ({ name, value }))))
        .addBooleanOption((o) => o.setName("enabled").setDescription("Turn automatic posts on or off"))),
    everywhere(new SlashCommandBuilder()
        .setName("status")
        .setDescription("Riot auth status and next shop resets")),
].map((c) => c.toJSON());

/**
 * @param {{store: import("../store.js").Store, shops: import("../shops.js").ShopService, catalog: import("../content.js").Catalog, emojis: import("./embeds.js").Emojis, ownerId: string}} deps
 */
export const createHandlers = ({ store, shops, catalog, emojis, ownerId }) => {
    const sections = {
        shop: (shop) => dailyEmbeds(shop, emojis, { wishlist: store.state.wishlist }),
        accessories: (shop) => accessoryEmbeds(shop, emojis, { wishlist: store.state.wishlist }),
        nightmarket: (shop) => nightMarketEmbeds(shop, emojis, { wishlist: store.state.wishlist }),
        bundle: (shop) => bundleEmbeds(shop, emojis),
    };
    // Each view returns messages (arrays of embeds); /store sends one or more per section.
    const views = {
        ...Object.fromEntries(Object.entries(sections).map(([name, view]) => [name, (shop) => [view(shop)]])),
        store: (shop) => pageEmbeds(Object.values(sections).map((view) => view(shop))),
    };

    const handleShop = async (interaction) => {
        const share = interaction.options.getBoolean("share") ?? false;
        const visibility = share ? {} : { flags: MessageFlags.Ephemeral };
        await interaction.deferReply(visibility);
        try {
            const shop = await shops.get();
            const [first, ...rest] = views[interaction.commandName](shop);
            await interaction.editReply({ embeds: first });
            for (const embeds of rest) await interaction.followUp({ embeds, ...visibility });
        } catch (err) {
            await interaction.editReply({ content: describeError(err) });
        }
    };

    const ephemeral = { flags: MessageFlags.Ephemeral };

    const handleWishlist = async (interaction) => {
        const sub = interaction.options.getSubcommand();
        await catalog.ensureLoaded();

        if (sub === "list") {
            const items = store.state.wishlist.map((uuid) => catalog.item(uuid));
            if (!items.length) return interaction.reply({ content: "Your wishlist is empty - add items with `/wishlist add`.", ...ephemeral });
            // Discord caps a message at 10 embeds, so longer lists go out as follow-ups.
            const pages = pageEmbeds(items.map((item) => wishlistItemEmbeds(item, emojis)));
            await interaction.reply({ content: `**Wishlist** (${items.length})`, embeds: pages[0], ...ephemeral });
            for (const embeds of pages.slice(1)) await interaction.followUp({ embeds, ...ephemeral });
            return;
        }

        const value = interaction.options.getString("item", true);
        const kind = interaction.options.getString("type");
        // Autocomplete sends the UUID; fall back to an exact name match if the user typed freely.
        const pool = sub === "remove" ? store.state.wishlist.map((uuid) => catalog.item(uuid)) : catalog.wishlistable;
        const item = pool.find((i) => i.uuid === value)
            ?? pool.find((i) => (!kind || i.kind === kind) && i.name.toLowerCase() === value.trim().toLowerCase());
        if (!item) return interaction.reply({ content: `Nothing matching "${value}". Pick one from the suggestions.`, ...ephemeral });

        if (sub === "add") {
            if (store.state.wishlist.includes(item.uuid)) {
                return interaction.reply({ content: `**${item.name}** is already on your wishlist.`, ...ephemeral });
            }
            store.update((s) => { s.wishlist.push(item.uuid); });
            const embeds = wishlistItemEmbeds(item, emojis, { large: true, note: "You'll get a DM when it shows up in your shop." });
            return interaction.reply({ content: "Added to your wishlist:", embeds, ...ephemeral });
        }

        store.update((s) => { s.wishlist = s.wishlist.filter((uuid) => uuid !== item.uuid); });
        return interaction.reply({ content: "Removed from your wishlist:", embeds: wishlistItemEmbeds(item, emojis), ...ephemeral });
    };

    const handleStatus = async (interaction) => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const lines = [];
        try {
            const shop = await shops.get();
            const session = shops.riot.session;
            lines.push(`✅ Riot auth OK${session?.name ? ` as **${session.name}**` : ""} (shard \`${session?.shard}\`)`);
            lines.push(`Daily shop resets <t:${Math.floor(shop.daily.resetsAt / 1000)}:R>`);
            if (shop.accessories.resetsAt) lines.push(`Accessories rotate <t:${Math.floor(shop.accessories.resetsAt / 1000)}:R>`);
            lines.push(shop.nightMarket ? `Night market closes <t:${Math.floor(shop.nightMarket.resetsAt / 1000)}:R>` : "Night market: closed");
        } catch (err) {
            lines.push(`❌ ${describeError(err)}`);
        }
        lines.push(`Wishlist: ${store.state.wishlist.length} item(s) · Auto-posts: ${describeAutoPost(store.state.autoPost)}`);
        await interaction.editReply({ content: lines.join("\n") });
    };

    const handleAutoPost = async (interaction) => {
        const section = interaction.options.getString("section");
        const enabled = interaction.options.getBoolean("enabled");
        if (section && enabled !== null) {
            store.update((s) => { s.autoPost[section] = enabled; });
        } else if (section || enabled !== null) {
            return interaction.reply({ content: "Pick both a `section` and `enabled`, or neither to see your settings.", ...ephemeral });
        }
        const lines = Object.entries(AUTO_POST_SECTIONS).map(([key, name]) => `${store.state.autoPost[key] ? "✅" : "⬜"} ${name}`);
        return interaction.reply({
            content: `**Automatic DMs when each section resets**\n${lines.join("\n")}\n-# Wishlist alerts are always on.`,
            ...ephemeral,
        });
    };

    const handleAutocomplete = async (interaction) => {
        await catalog.ensureLoaded().catch(() => {});
        const query = interaction.options.getFocused();
        const sub = interaction.options.getSubcommand();
        const q = query.trim().toLowerCase();
        const items = sub === "remove"
            ? store.state.wishlist.map((uuid) => catalog.item(uuid)).filter((i) => i.name.toLowerCase().includes(q))
            : catalog.searchWishlistable(query, { kind: interaction.options.getString("type") });
        await interaction.respond(items.slice(0, 25).map((i) => ({
            name: `${i.name} · ${KIND_CHOICES[i.kind] ?? "Item"}`.slice(0, 100),
            value: i.uuid,
        })));
    };

    return async (interaction) => {
        // Single-user bot: the Riot session behind it is the owner's.
        if (interaction.user.id !== ownerId) {
            if (interaction.isAutocomplete()) return interaction.respond([]);
            if (interaction.isRepliable()) {
                return interaction.reply({ content: "This is a private bot.", flags: MessageFlags.Ephemeral });
            }
            return;
        }

        if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName in views) return handleShop(interaction);
        if (interaction.commandName === "wishlist") return handleWishlist(interaction);
        if (interaction.commandName === "autopost") return handleAutoPost(interaction);
        if (interaction.commandName === "status") return handleStatus(interaction);
    };
};

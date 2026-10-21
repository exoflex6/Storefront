import {
    ApplicationIntegrationType,
    EmbedBuilder,
    InteractionContextType,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { accessoryEmbeds, bundleEmbeds, dailyEmbeds, nightMarketEmbeds } from "./embeds.js";
import { describeError } from "../errors.js";

// Every command must be installable on both guilds and user accounts and usable
// everywhere, or it won't show up for a user install.
const everywhere = (builder) => builder
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);

const shareOption = (builder) => builder.addBooleanOption((o) => o
    .setName("share")
    .setDescription("Post visibly instead of only to you (default: only you)"));

const shopCommand = (name, description) => everywhere(shareOption(new SlashCommandBuilder().setName(name).setDescription(description)));

export const commandDefinitions = [
    shopCommand("shop", "Your daily Valorant skin shop"),
    shopCommand("accessories", "Your Valorant accessory store"),
    shopCommand("nightmarket", "Your Valorant night market, if it's open"),
    shopCommand("bundle", "The current featured bundle(s)"),
    everywhere(new SlashCommandBuilder()
        .setName("wishlist")
        .setDescription("Skins to alert you about")
        .addSubcommand((s) => s.setName("add").setDescription("Add a skin to your wishlist")
            .addStringOption((o) => o.setName("skin").setDescription("Skin name").setRequired(true).setAutocomplete(true)))
        .addSubcommand((s) => s.setName("remove").setDescription("Remove a skin from your wishlist")
            .addStringOption((o) => o.setName("skin").setDescription("Skin name").setRequired(true).setAutocomplete(true)))
        .addSubcommand((s) => s.setName("list").setDescription("Show your wishlist"))),
    everywhere(new SlashCommandBuilder()
        .setName("status")
        .setDescription("Riot auth status and next shop resets")),
].map((c) => c.toJSON());

/**
 * @param {{store: import("../store.js").Store, shops: import("../shops.js").ShopService, catalog: import("../content.js").Catalog, emojis: import("./embeds.js").Emojis, ownerId: string}} deps
 */
export const createHandlers = ({ store, shops, catalog, emojis, ownerId }) => {
    const views = {
        shop: (shop) => dailyEmbeds(shop, emojis, { wishlist: store.state.wishlist }),
        accessories: (shop) => accessoryEmbeds(shop, emojis),
        nightmarket: (shop) => nightMarketEmbeds(shop, emojis, { wishlist: store.state.wishlist }),
        bundle: (shop) => bundleEmbeds(shop, emojis),
    };

    const handleShop = async (interaction) => {
        const share = interaction.options.getBoolean("share") ?? false;
        await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
        try {
            const shop = await shops.get();
            await interaction.editReply({ embeds: views[interaction.commandName](shop) });
        } catch (err) {
            await interaction.editReply({ content: describeError(err) });
        }
    };

    const handleWishlist = async (interaction) => {
        const sub = interaction.options.getSubcommand();
        await catalog.ensureLoaded();

        if (sub === "list") {
            const names = store.state.wishlist.map((uuid) => catalog.skins.get(uuid)?.name ?? `Unknown skin (${uuid.slice(0, 8)})`);
            const embed = new EmbedBuilder()
                .setTitle("Wishlist")
                .setDescription(names.length ? names.map((n) => `• ${n}`).join("\n").slice(0, 4096) : "Empty - add skins with `/wishlist add`.")
                .setColor(0xff4655);
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const value = interaction.options.getString("skin", true);
        // Autocomplete sends the UUID; fall back to an exact name match if the user typed freely.
        const skin = catalog.skins.get(value)
            ?? [...catalog.skins.values()].find((s) => s.name.toLowerCase() === value.trim().toLowerCase());
        if (!skin) return interaction.reply({ content: `No skin matching "${value}". Pick one from the suggestions.`, flags: MessageFlags.Ephemeral });

        if (sub === "add") {
            if (store.state.wishlist.includes(skin.uuid)) {
                return interaction.reply({ content: `**${skin.name}** is already on your wishlist.`, flags: MessageFlags.Ephemeral });
            }
            store.update((s) => { s.wishlist.push(skin.uuid); });
            return interaction.reply({ content: `Added **${skin.name}**. You'll get a DM when it shows up.`, flags: MessageFlags.Ephemeral });
        }

        store.update((s) => { s.wishlist = s.wishlist.filter((uuid) => uuid !== skin.uuid); });
        return interaction.reply({ content: `Removed **${skin.name}**.`, flags: MessageFlags.Ephemeral });
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
        lines.push(`Wishlist: ${store.state.wishlist.length} skin(s) · Daily DM: ${shops.dailyDm ? "on" : "off"}`);
        await interaction.editReply({ content: lines.join("\n") });
    };

    const handleAutocomplete = async (interaction) => {
        await catalog.ensureLoaded().catch(() => {});
        const query = interaction.options.getFocused();
        const sub = interaction.options.getSubcommand();
        const q = query.trim().toLowerCase();
        const skins = sub === "remove"
            ? store.state.wishlist.map((uuid) => catalog.skins.get(uuid)).filter((s) => s && s.name.toLowerCase().includes(q))
            : catalog.searchSkins(query);
        await interaction.respond(skins.slice(0, 25).map((s) => ({ name: s.name.slice(0, 100), value: s.uuid })));
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
        if (interaction.commandName === "status") return handleStatus(interaction);
    };
};

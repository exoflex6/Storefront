import { Client, Events } from "discord.js";
import { config } from "./config.js";
import { Store } from "./store.js";
import { RiotClient } from "./riot/client.js";
import { Catalog } from "./content.js";
import { ShopService } from "./shops.js";
import { Emojis } from "./discord/embeds.js";
import { createHandlers } from "./discord/commands.js";

const store = new Store(config.dataDir);
store.seedCookies(config.riotCookieSeed);
if (!store.state.cookies.ssid) {
    console.warn("[auth] no ssid cookie yet - set RIOT_SSID in .env. Shop commands will fail until then.");
}

// Interactions arrive over the gateway without any privileged intents.
const client = new Client({ intents: [] });
const emojis = new Emojis();
const catalog = new Catalog();
const riot = new RiotClient(store, { shard: config.shard });

/**
 * A user-installed app can't post in channels on its own, so alerts are DMs.
 * Discord may refuse the DM (code 50007) if the bot shares no server with you.
 */
const notify = async (payload) => {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(payload);
};

const shops = new ShopService({ riot, catalog, store, emojis, dailyDm: config.dailyDm, notify });
const handle = createHandlers({ store, shops, catalog, emojis, ownerId: config.ownerId });

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        await handle(interaction);
    } catch (err) {
        console.error(`[interaction] ${interaction.commandName ?? "?"}:`, err);
    }
});

client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    await emojis.load(c.application);
    shops.start();
});

const shutdown = () => {
    shops.stop();
    client.destroy().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await client.login(config.discordToken);

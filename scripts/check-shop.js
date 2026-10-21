// Fetch the shop once and print it, without Discord. Useful to verify the ssid
// cookie and endpoints after a patch: `npm run check`.
import { config } from "../src/config.js";
import { Store } from "../src/store.js";
import { RiotClient } from "../src/riot/client.js";
import { Catalog } from "../src/content.js";
import { parseStorefront } from "../src/shop.js";
import { describeError } from "../src/errors.js";

const store = new Store(config.dataDir);
store.seedCookies(config.riotCookieSeed);
const riot = new RiotClient(store, { shard: config.shard });
const catalog = new Catalog();

try {
    const [raw] = await Promise.all([riot.storefront(), catalog.ensureLoaded()]);
    const shop = parseStorefront(raw, catalog);
    const when = (ms) => (ms ? new Date(ms).toISOString() : "?");
    const list = (items, fmt) => items.map((i) => `  - ${fmt(i)}`).join("\n");

    console.log(`Account: ${riot.session.name ?? riot.session.puuid} (shard ${riot.session.shard})\n`);
    console.log(`Daily shop (resets ${when(shop.daily.resetsAt)}):\n${list(shop.daily.items, (i) => `${i.name} - ${i.price} VP`)}\n`);
    console.log(`Accessories (rotate ${when(shop.accessories.resetsAt)}):\n${list(shop.accessories.items, (i) => `[${i.kind}] ${i.name} - ${i.price} KC`)}\n`);
    console.log(shop.nightMarket
        ? `Night market (closes ${when(shop.nightMarket.resetsAt)}):\n${list(shop.nightMarket.items, (i) => `${i.name} - ${i.price} VP (-${i.discountPercent}%)`)}\n`
        : "Night market: closed\n");
    for (const b of shop.bundles) console.log(`Bundle: ${b.name} - ${b.price} VP, ${b.items.length} items (leaves ${when(b.resetsAt)})`);
} catch (err) {
    console.error(describeError(err));
    process.exitCode = 1;
}

// Registers slash commands globally. User-install commands only exist at global
// scope, so there's no per-guild mode. Global updates can take a few minutes to show.
import { REST, Routes } from "discord.js";
import { config } from "../src/config.js";
import { commandDefinitions } from "../src/discord/commands.js";

const rest = new REST().setToken(config.discordToken);
const app = await rest.get(Routes.currentApplication());
const result = await rest.put(Routes.applicationCommands(app.id), { body: commandDefinitions });
console.log(`Registered ${result.length} global commands for ${app.name}: ${result.map((c) => `/${c.name}`).join(", ")}`);

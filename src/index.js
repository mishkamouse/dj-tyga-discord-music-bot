require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { startInternalApi } = require('./internal/api');
const { handleButtonInteraction } = require('./discord/buttonHandler');
const { peekQueue } = require('./music/queueManager');

startInternalApi();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  client.commands.set(command.data.name, command);
}

async function registerCommands() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  const body = client.commands.map((c) => c.data.toJSON());

  if (process.env.DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body },
    );
    console.log(`Registered ${body.length} command(s) to guild ${process.env.DISCORD_GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body });
    console.log(`Registered ${body.length} global command(s) (propagation can take up to an hour).`);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    try {
      await handleButtonInteraction(interaction);
    } catch (err) {
      console.error(`Error handling button ${interaction.customId}:`, err);
      await interaction.reply({ content: 'Something went wrong with that button.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error executing /${interaction.commandName}:`, err);
    const payload = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// Drives 24/7 mode's alone-for-over-an-hour timeout. Irrelevant for any guild without an
// active 24/7 queue, which peekQueue's no-create lookup keeps cheap to check.
client.on('voiceStateUpdate', (oldState, newState) => {
  const queue = peekQueue(newState.guild.id);
  if (!queue?.persistent || !queue.connection) return;

  const channelId = queue.connection.joinConfig.channelId;
  if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

  const channel = newState.guild.channels.cache.get(channelId);
  if (channel) queue.checkAlone(channel);
});

client.login(process.env.DISCORD_TOKEN);

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set the loop mode')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' },
        ),
    ),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    const mode = interaction.options.getString('mode', true);
    queue.setLoop(mode);
    await interaction.reply(`Loop mode set to **${mode}**.`);
  },
};

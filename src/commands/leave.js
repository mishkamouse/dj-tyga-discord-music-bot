const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    queue.stop();
    await interaction.reply('Left the voice channel.');
  },
};

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop playback, clear the queue, and leave'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    queue.stop();
    await interaction.reply('Stopped and cleared the queue.');
  },
};

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (queue.tracks.length < 2) {
      return interaction.reply({ content: 'Not enough tracks to shuffle.', ephemeral: true });
    }
    queue.shuffle();
    await interaction.reply('Shuffled the queue.');
  },
};

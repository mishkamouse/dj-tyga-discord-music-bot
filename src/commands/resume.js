const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume the current track'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue.current) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    queue.resume();
    await interaction.reply('Resumed.');
  },
};

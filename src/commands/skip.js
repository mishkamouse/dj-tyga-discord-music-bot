const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue.current) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    const skipped = queue.current.title;
    queue.skip();
    await interaction.reply(`Skipped **${skipped}**.`);
  },
};

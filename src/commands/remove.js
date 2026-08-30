const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue')
    .addIntegerOption((opt) =>
      opt.setName('index').setDescription('Position in the queue (see /queue)').setRequired(true).setMinValue(1),
    ),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    const index = interaction.options.getInteger('index', true) - 1;
    const removed = queue.remove(index);
    if (!removed) return interaction.reply({ content: 'No track at that position.', ephemeral: true });
    await interaction.reply(`Removed **${removed.title}**.`);
  },
};

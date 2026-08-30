const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');
const { queueEmbed } = require('../discord/embeds');
const { queuePaginationButtons } = require('../discord/components');

module.exports = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue.current && queue.tracks.length === 0) {
      return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
    }

    const { embed, page, totalPages } = queueEmbed(queue, 0);
    await interaction.reply({ embeds: [embed], components: queuePaginationButtons(page, totalPages) });
  },
};

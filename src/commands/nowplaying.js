const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');
const { nowPlayingEmbed } = require('../discord/embeds');
const { nowPlayingButtons } = require('../discord/components');

module.exports = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue.current) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });

    await interaction.reply({ embeds: [nowPlayingEmbed(queue)], components: [nowPlayingButtons(queue)] });
    const message = await interaction.fetchReply();
    queue.retireNowPlayingCard(message);
  },
};

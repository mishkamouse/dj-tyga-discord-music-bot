const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('247')
    .setDescription('Toggle 24/7 mode — stay connected indefinitely instead of leaving on an empty queue'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (queue.persistent) {
      queue.disablePersistent();
      return interaction.reply("24/7 mode off — back to leaving after a few minutes of an empty queue.");
    }

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    }
    if (queue.connection && queue.connection.joinConfig.channelId !== voiceChannel.id) {
      return interaction.reply({ content: "I'm already playing in another voice channel here.", ephemeral: true });
    }

    queue.textChannel = interaction.channel;
    if (!queue.connection) queue.connect(voiceChannel);
    queue.enablePersistent();
    queue.checkAlone(voiceChannel);

    await interaction.reply("24/7 mode on — I'll stay connected unless you all leave.");
  },
};

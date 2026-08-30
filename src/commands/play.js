const { SlashCommandBuilder } = require('discord.js');
const { resolveInput } = require('../music/resolve');
const { getQueue } = require('../music/queueManager');
const { trackAddedEmbed, playlistAddedEmbed } = require('../discord/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist from YouTube')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Search term, video URL, or playlist URL').setRequired(true),
    ),
  async execute(interaction) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    }

    const queue = getQueue(interaction.guildId);
    if (queue.connection && queue.connection.joinConfig.channelId !== voiceChannel.id) {
      return interaction.reply({ content: "I'm already playing in another voice channel here.", ephemeral: true });
    }

    await interaction.deferReply();
    queue.textChannel = interaction.channel;

    let result;
    try {
      result = await resolveInput(interaction.options.getString('query', true));
    } catch (err) {
      return interaction.editReply(`Couldn't find anything for that: ${err.message}`);
    }

    if (!queue.connection) queue.connect(voiceChannel);

    const wasIdle = !queue.current;
    const position = queue.tracks.length; // where the new track(s) land, before enqueue shifts one out if idle
    const requestedBy = interaction.user.tag;
    const tracks = (result.type === 'playlist' ? result.tracks : [result.track]).map((t) => ({
      ...t,
      requestedBy,
    }));
    queue.enqueue(tracks);

    if (result.type === 'playlist') {
      await interaction.editReply({ embeds: [playlistAddedEmbed(tracks, result.title)] });
    } else {
      await interaction.editReply({ embeds: [trackAddedEmbed(tracks[0], { position: wasIdle ? 0 : position })] });
    }
  },
};

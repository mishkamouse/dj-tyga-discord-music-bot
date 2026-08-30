const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');
const { isConfigured, askAgent } = require('../internal/agentClient');
const { assistantReplyEmbed } = require('../discord/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Tell the bot what you want in plain language (e.g. "queue up some upbeat 2016 songs")')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('What do you want the queue to do?').setRequired(true),
    ),
  async execute(interaction) {
    if (!isConfigured()) {
      return interaction.reply({ content: 'The natural-language assistant is not configured on this bot.', ephemeral: true });
    }

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
    if (!queue.connection) queue.connect(voiceChannel);

    try {
      const reply = await askAgent(
        interaction.guildId,
        interaction.options.getString('query', true),
        interaction.user.tag,
      );
      await interaction.editReply({ embeds: [assistantReplyEmbed(reply)] });
    } catch (err) {
      console.error(`[guild ${interaction.guildId}] /ask failed:`, err.message);
      await interaction.editReply("Couldn't reach the assistant. Try again in a moment.");
    }
  },
};

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');
const { searchYoutube } = require('../music/resolve');
const { radioStartedEmbed } = require('../discord/embeds');

// Easy to change without touching code — e.g. RADIO_DEFAULT_QUERY="90s R&B" in .env.
const DEFAULT_QUERY = process.env.RADIO_DEFAULT_QUERY || 'Kanye West';
const RADIO_POOL_SIZE = 30;

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Start a continuous shuffled radio rotation (defaults to a preset topic if none given)')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('What kind of radio? (artist, genre, mood, era...)').setRequired(false),
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
    if (!queue.connection) queue.connect(voiceChannel);

    const topic = interaction.options.getString('query') || DEFAULT_QUERY;

    // One search call covering the whole topic — deliberately not going through the LLM
    // agent here: curating song-by-song is slower (many round trips) and unnecessary for
    // "give me a playlist of X", where YouTube's own search already returns good variety.
    // /ask remains the path for genuinely specific curation requests.
    let results;
    try {
      results = await searchYoutube(topic, RADIO_POOL_SIZE);
    } catch (err) {
      console.error(`[guild ${interaction.guildId}] /radio search failed:`, err.message);
      return interaction.editReply(`Couldn't find anything for **${topic}**.`);
    }
    if (results.length === 0) {
      return interaction.editReply(`Couldn't find anything for **${topic}**.`);
    }

    queue.clearQueue();
    if (queue.current) queue.skip();
    queue.setLoop('queue');

    const requestedBy = interaction.user.tag;
    queue.enqueue(shuffleArray(results).map((t) => ({ ...t, requestedBy })));

    await interaction.editReply({ embeds: [radioStartedEmbed(topic, results.length)] });
  },
};

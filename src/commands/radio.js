const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/queueManager');
const radioStore = require('../music/radioStore');
const { startRadio, reconcile } = require('../music/radioManager');
const { radioStartedEmbed, radioArtistsEmbed } = require('../discord/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Continuous radio built from a rotation of artists you control')
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('Start radio from your saved artist rotation')
        .addStringOption((opt) =>
          opt.setName('artist').setDescription('Add this artist to the rotation before starting').setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('off').setDescription('Turn off radio mode'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add an artist to the rotation')
        .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove an artist from the rotation')
        .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the current artist rotation')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on') return handleOn(interaction);
    if (sub === 'off') return handleOff(interaction);
    if (sub === 'add') return handleAdd(interaction);
    if (sub === 'remove') return handleRemove(interaction);
    return handleList(interaction);
  },
};

async function handleOn(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
  }

  const queue = getQueue(interaction.guildId);
  if (queue.connection && queue.connection.joinConfig.channelId !== voiceChannel.id) {
    return interaction.reply({ content: "I'm already playing in another voice channel here.", ephemeral: true });
  }

  const artist = interaction.options.getString('artist');
  if (artist) radioStore.addArtist(interaction.guildId, artist);

  await interaction.deferReply();
  queue.textChannel = interaction.channel;
  if (!queue.connection) queue.connect(voiceChannel);

  try {
    const { artists, count } = await startRadio(queue, interaction.guildId, interaction.user.tag);
    await interaction.editReply({ embeds: [radioStartedEmbed(artists, count)] });
  } catch (err) {
    console.error(`[guild ${interaction.guildId}] /radio on failed:`, err.message);
    await interaction.editReply(err.message);
  }
}

async function handleOff(interaction) {
  const queue = getQueue(interaction.guildId);
  if (!queue.radioMode) {
    return interaction.reply({ content: 'Radio isn\'t on.', ephemeral: true });
  }
  queue.radioMode = false;
  queue.setLoop('off');
  await interaction.reply("Radio mode off — I'll finish what's queued and then stop.");
}

async function handleAdd(interaction) {
  const artist = interaction.options.getString('artist', true);
  const queue = getQueue(interaction.guildId);
  radioStore.addArtist(interaction.guildId, artist);

  await interaction.deferReply();
  if (queue.radioMode) {
    try {
      await reconcile(queue, interaction.guildId);
    } catch (err) {
      console.error(`[guild ${interaction.guildId}] radio reconcile failed:`, err.message);
    }
    return interaction.editReply(`Added **${artist}** to the rotation — the queue now reflects it.`);
  }
  return interaction.editReply(`Added **${artist}** to the rotation. Start with \`/radio on\`.`);
}

async function handleRemove(interaction) {
  const artist = interaction.options.getString('artist', true);
  const existed = radioStore
    .getArtists(interaction.guildId)
    .some((a) => a.toLowerCase() === artist.toLowerCase());
  if (!existed) {
    return interaction.reply({ content: `**${artist}** isn't in the rotation.`, ephemeral: true });
  }

  const queue = getQueue(interaction.guildId);
  radioStore.removeArtist(interaction.guildId, artist);

  await interaction.deferReply();
  if (queue.radioMode) {
    try {
      await reconcile(queue, interaction.guildId);
    } catch (err) {
      console.error(`[guild ${interaction.guildId}] radio reconcile failed:`, err.message);
    }
    return interaction.editReply(`Removed **${artist}** from the rotation — the queue now reflects it.`);
  }
  return interaction.editReply(`Removed **${artist}** from the rotation.`);
}

async function handleList(interaction) {
  const artists = radioStore.getArtists(interaction.guildId);
  await interaction.reply({ embeds: [radioArtistsEmbed(artists)] });
}

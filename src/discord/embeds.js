const { EmbedBuilder } = require('discord.js');
const { formatDuration, progressBar, thumbnailUrl, truncate } = require('./format');

const COLOR = {
  nowPlaying: 0x1db954, // spotify-ish green — "something is playing"
  queue: 0x5865f2, // discord blurple — neutral state view
  added: 0x57f287, // green — successful add
  assistant: 0xeb459e, // pink — /ask, /radio (the LLM talking)
};

const LOOP_LABEL = { off: 'Off', track: 'Track', queue: 'Queue' };
const QUEUE_PAGE_SIZE = 10;

function nowPlayingEmbed(queue) {
  const track = queue.current;
  if (!track) {
    return new EmbedBuilder().setColor(COLOR.queue).setDescription('Nothing is playing right now.');
  }
  const elapsed = queue.getElapsedSeconds();
  const embed = new EmbedBuilder()
    .setColor(queue.isPaused() ? COLOR.queue : COLOR.nowPlaying)
    .setAuthor({ name: queue.isPaused() ? 'Paused' : 'Now Playing' })
    .setTitle(truncate(track.title, 256))
    .setURL(track.url)
    .setDescription(progressBar(elapsed, track.duration))
    .addFields(
      { name: 'Requested by', value: track.requestedBy || 'Unknown', inline: true },
      { name: 'Loop', value: LOOP_LABEL[queue.loopMode] ?? 'Off', inline: true },
      ...(queue.persistent ? [{ name: '24/7', value: 'On', inline: true }] : []),
      { name: 'Up next', value: queue.tracks[0] ? queue.tracks[0].title : '*Queue is empty*', inline: false },
    );
  const thumb = thumbnailUrl(track.url);
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}

function queueEmbed(queue, page = 0) {
  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / QUEUE_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = clampedPage * QUEUE_PAGE_SIZE;
  const pageTracks = queue.tracks.slice(start, start + QUEUE_PAGE_SIZE);

  const embed = new EmbedBuilder().setColor(COLOR.queue).setTitle('Queue');

  if (queue.current) {
    embed.addFields({
      name: 'Now playing',
      value: `**[${queue.current.title}](${queue.current.url})** — ${formatDuration(queue.current.duration)} · requested by ${queue.current.requestedBy || 'Unknown'}${queue.isPaused() ? ' *(paused)*' : ''}`,
    });
    const thumb = thumbnailUrl(queue.current.url);
    if (thumb) embed.setThumbnail(thumb);
  }

  if (pageTracks.length === 0) {
    embed.addFields({ name: 'Up next', value: '*Queue is empty.*' });
  } else {
    const lines = pageTracks.map(
      (t, i) =>
        `**${start + i + 1}.** [${truncate(t.title, 80)}](${t.url}) — ${formatDuration(t.duration)} · ${t.requestedBy || 'Unknown'}`,
    );
    embed.addFields({ name: 'Up next', value: truncate(lines.join('\n'), 1024) });
  }

  embed.setFooter({
    text: `Page ${clampedPage + 1}/${totalPages} · ${queue.tracks.length} queued · Loop: ${LOOP_LABEL[queue.loopMode] ?? 'Off'}`,
  });
  return { embed, page: clampedPage, totalPages };
}

function trackAddedEmbed(track, { position } = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLOR.added)
    .setAuthor({ name: position === 0 ? 'Playing now' : 'Added to queue' })
    .setTitle(truncate(track.title, 256))
    .setURL(track.url)
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      ...(position != null && position > 0 ? [{ name: 'Position', value: `#${position + 1}`, inline: true }] : []),
    );
  const thumb = thumbnailUrl(track.url);
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}

function playlistAddedEmbed(tracks, title) {
  return new EmbedBuilder()
    .setColor(COLOR.added)
    .setAuthor({ name: 'Playlist queued' })
    .setTitle(truncate(title || 'Playlist', 256))
    .setDescription(`Added **${tracks.length}** tracks to the queue.`);
}

function radioStartedEmbed(topic, count) {
  return new EmbedBuilder()
    .setColor(COLOR.added)
    .setAuthor({ name: '📻 Radio started' })
    .setTitle(truncate(topic, 256))
    .setDescription(`${count} songs queued and shuffled on continuous loop.`);
}

function assistantReplyEmbed(text, { title } = {}) {
  return new EmbedBuilder()
    .setColor(COLOR.assistant)
    .setAuthor({ name: title || 'Assistant' })
    .setDescription(truncate(text, 4096) || "Done, but I didn't have anything to say about it.");
}

module.exports = {
  nowPlayingEmbed,
  queueEmbed,
  trackAddedEmbed,
  playlistAddedEmbed,
  radioStartedEmbed,
  assistantReplyEmbed,
};

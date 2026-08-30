const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// customIds are self-contained (no guildId embedded) — the interaction itself always
// carries the guild it came from, so the button handler just reads interaction.guildId.
function nowPlayingButtons(queue) {
  const paused = queue.isPaused();
  const loopStyle = { off: ButtonStyle.Secondary, track: ButtonStyle.Primary, queue: ButtonStyle.Success }[
    queue.loopMode
  ];
  const loopLabel = { off: '🔁 Loop', track: '🔂 Track', queue: '🔁 Queue' }[queue.loopMode];

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mb:playpause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mb:skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mb:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mb:shuffle').setLabel('Shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mb:loop').setLabel(loopLabel).setStyle(loopStyle),
  );
}

function disabledRow(row) {
  const disabled = ActionRowBuilder.from(row);
  disabled.components.forEach((c) => c.setDisabled(true));
  return disabled;
}

function queuePaginationButtons(page, totalPages) {
  if (totalPages <= 1) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mb:queue:${page - 1}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`mb:queue:${page + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    ),
  ];
}

module.exports = { nowPlayingButtons, disabledRow, queuePaginationButtons };

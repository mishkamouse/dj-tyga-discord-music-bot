const { getQueue } = require('../music/queueManager');
const { nowPlayingEmbed, queueEmbed } = require('./embeds');
const { nowPlayingButtons, queuePaginationButtons } = require('./components');

const LOOP_CYCLE = { off: 'track', track: 'queue', queue: 'off' };

async function handleButtonInteraction(interaction) {
  const [, action, arg] = interaction.customId.split(':');
  const queue = getQueue(interaction.guildId);

  if (action === 'queue') {
    const { embed, page, totalPages } = queueEmbed(queue, Number(arg) || 0);
    return interaction.update({ embeds: [embed], components: queuePaginationButtons(page, totalPages) });
  }

  if (!queue.current) {
    return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
  }

  if (action === 'stop') {
    queue.stop();
    return interaction.update({ embeds: [nowPlayingEmbed(queue)], components: [] });
  }

  if (action === 'skip') {
    queue.skip();
    // The next track (if any) takes a moment to resolve — playNext() posts its own fresh
    // card via postNowPlaying() and disables this one, so just acknowledge the click here
    // rather than racing it with a guess at the new state.
    return interaction.deferUpdate();
  }

  switch (action) {
    case 'playpause':
      if (queue.isPaused()) queue.resume();
      else queue.pause();
      break;
    case 'shuffle':
      queue.shuffle();
      break;
    case 'loop':
      queue.setLoop(LOOP_CYCLE[queue.loopMode]);
      break;
    default:
      return;
  }

  queue.retireNowPlayingCard(interaction.message);
  return interaction.update({ embeds: [nowPlayingEmbed(queue)], components: [nowPlayingButtons(queue)] });
}

module.exports = { handleButtonInteraction };

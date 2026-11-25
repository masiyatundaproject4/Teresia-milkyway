export async function testIncomingRingtone() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return false;
  let context;
  try {
    context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 440;
    gain.gain.value = 0.0001;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    const resumed = context.state === 'suspended' ? context.resume() : Promise.resolve();
    const now = context.currentTime + 0.05;
    for (const offset of [0, 0.42]) {
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.14, now + offset + 0.03);
      gain.gain.setValueAtTime(0.14, now + offset + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.25);
    }
    await resumed;
    if (context.state !== 'running') throw new Error('Audio playback is blocked.');
    setTimeout(() => {
      oscillator.stop();
      context.close().catch(error => console.warn('[call] ringtone test cleanup failed', error));
    }, 1000);
    return true;
  } catch (error) {
    if (context && context.state !== 'closed') context.close().catch(closeError => console.warn('[call] ringtone test cleanup failed', closeError));
    console.warn('[call] ringtone test could not play', error);
    return false;
  }
}

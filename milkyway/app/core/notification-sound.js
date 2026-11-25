let context = null;
let unlocking = false;

export async function unlockNotificationSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return false;
  try {
    if (!context) context = new AudioContext();
    if (context.state !== 'running') await context.resume();
    return context.state === 'running';
  } catch (error) {
    console.info('[notifications] Message sound is blocked until audio is enabled.', error);
    return false;
  }
}

export async function playMessageAlert() {
  if (!await unlockNotificationSound()) return false;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = 'sine';
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.22);
  return true;
}

function primeFromGesture() {
  if (unlocking) return;
  unlocking = true;
  void unlockNotificationSound().finally(() => { unlocking = false; });
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', primeFromGesture, { passive: true });
  document.addEventListener('keydown', primeFromGesture);
}

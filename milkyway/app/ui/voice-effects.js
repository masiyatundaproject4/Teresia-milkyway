export const VOICE_PRESETS = [
  { id: 'normal', key: 'voicePresetNormal', semitones: 0, filter: 0 },
  { id: 'child', key: 'voicePresetChild', semitones: 5, filter: 2200 },
  { id: 'female', key: 'voicePresetFemale', semitones: 3, filter: 1800 },
  { id: 'male', key: 'voicePresetMale', semitones: -3, filter: 900 },
  { id: 'robot', key: 'voicePresetRobot', semitones: 0, filter: 1400, robot: true },
  { id: 'chipmunk', key: 'voicePresetChipmunk', semitones: 9, filter: 2800 },
  { id: 'monster', key: 'voicePresetMonster', semitones: -8, filter: 650 },
  { id: 'radio', key: 'voicePresetRadio', semitones: 0, filter: 1900, radio: true },
];

const presetById = new Map(VOICE_PRESETS.map(preset => [preset.id, preset]));

function interpolate(buffer, position) {
  const index = Math.floor(position);
  const fraction = position - index;
  const a = buffer[index % buffer.length] || 0;
  const b = buffer[(index + 1) % buffer.length] || 0;
  return a + (b - a) * fraction;
}

/**
 * Creates a stable processed stream so preset changes never replace the published/recorded track.
 * The dual overlapping delay heads provide a lightweight real-time pitch shift in browsers with ScriptProcessor.
 */
export function createVoiceEffects(inputStream, presetId = 'normal') {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('Audio processing is not supported in this browser.');
  const context = new AudioContext();
  let source, shifter, filter, output;
  try {
    source = context.createMediaStreamSource(inputStream);
    shifter = context.createScriptProcessor(2048, 1, 1);
    filter = context.createBiquadFilter();
    output = context.createMediaStreamDestination();
  } catch (error) {
    context.close().catch(() => {});
    throw error;
  }
  const ringSize = 16384;
  const grainSize = 4096;
  const minDelay = 4096;
  let writeIndex = 0;
  let phase = 0;
  let pitchRatio = 1;
  let preset = presetById.get(presetId) || presetById.get('normal');
  const rings = [];

  context.resume().catch(() => {});
  if (!shifter) {
    context.close().catch(() => {});
    throw new Error('Real-time voice effects are not supported in this browser.');
  }
  shifter.onaudioprocess = event => {
    const inputBuffer = event.inputBuffer;
    const outputBuffer = event.outputBuffer;
    const channels = Math.min(inputBuffer.numberOfChannels, outputBuffer.numberOfChannels);
    for (let i = 0; i < outputBuffer.length; i++) {
      for (let channel = 0; channel < channels; channel++) {
        const input = inputBuffer.getChannelData(channel);
        const result = outputBuffer.getChannelData(channel);
        const ring = rings[channel] ||= new Float32Array(ringSize);
        const sample = input[i] || 0;
        ring[writeIndex] = sample;
        const phaseA = phase;
        const phaseB = (phase + 0.5) % 1;
        const delayA = minDelay + phaseA * grainSize * (1 - pitchRatio);
        const delayB = minDelay + phaseB * grainSize * (1 - pitchRatio);
        const valueA = interpolate(ring, (writeIndex - delayA + ringSize) % ringSize);
        const valueB = interpolate(ring, (writeIndex - delayB + ringSize) % ringSize);
        const blendA = 0.5 - 0.5 * Math.cos(phaseA * Math.PI * 2);
        const blendB = 0.5 - 0.5 * Math.cos(phaseB * Math.PI * 2);
        result[i] = pitchRatio === 1 ? sample : (valueA * blendA + valueB * blendB) / Math.max(0.001, blendA + blendB);
      }
      writeIndex = (writeIndex + 1) % ringSize;
      phase += 1 / grainSize;
      if (phase >= 1) phase -= 1;
    }
  };
  filter.type = preset.radio ? 'bandpass' : 'lowpass';
  filter.frequency.value = preset.filter || 20000;
  filter.Q.value = preset.radio ? 1.2 : 0.7;
  source.connect(shifter).connect(filter).connect(output);

  let oscillator;
  let modulation;
  const setPreset = id => {
    const next = presetById.get(id);
    if (!next) throw new Error(`Unknown voice preset: ${id}`);
    preset = next;
    pitchRatio = 2 ** (next.semitones / 12);
    const now = context.currentTime;
    filter.frequency.setTargetAtTime(next.filter || 20000, now, 0.04);
    filter.type = next.radio ? 'bandpass' : 'lowpass';
    filter.Q.setTargetAtTime(next.radio ? 1.2 : 0.7, now, 0.04);
    if (next.robot && !oscillator) {
      const carrier = context.createGain();
      modulation = context.createGain();
      oscillator = context.createOscillator();
      oscillator.type = 'square';
      oscillator.frequency.value = 34;
      modulation.gain.value = 0;
      filter.disconnect();
      filter.connect(carrier);
      oscillator.connect(modulation);
      modulation.connect(carrier.gain);
      carrier.connect(output);
      oscillator.start();
    } else if (oscillator) {
      modulation.gain.setTargetAtTime(next.robot ? 0.45 : 0, context.currentTime, 0.04);
    }
  };
  setPreset(preset.id);

  return {
    stream: output.stream,
    setPreset,
    close() {
      shifter.onaudioprocess = null;
      oscillator?.stop();
      source.disconnect();
      shifter.disconnect();
      filter.disconnect();
      modulation?.disconnect();
      output.disconnect();
      if (context.state !== 'closed') context.close().catch(() => {});
    },
  };
}

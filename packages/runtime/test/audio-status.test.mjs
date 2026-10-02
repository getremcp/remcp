import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAmixerAudioStatus,
  parsePactlAudioStatus,
  parseWpctlAudioStatus,
} from '../src/extended/diagnostics.mjs';

test('wpctl audio status normalizes scalar volume and mute state', () => {
  assert.deepEqual(parseWpctlAudioStatus('Volume: 0.42'), { volume:42, muted:false });
  assert.deepEqual(parseWpctlAudioStatus('Volume: 0.00 [MUTED]'), { volume:0, muted:true });
  assert.deepEqual(parseWpctlAudioStatus('Volume: 1.25'), { volume:100, muted:false });
  assert.throws(() => parseWpctlAudioStatus('unexpected'), /unrecognized/i);
});

test('pactl audio status returns stable 0-100 volume and mute fields', () => {
  const volume = 'Volume: front-left: 32768 /  50% / -18.06 dB,   front-right: 32768 /  50% / -18.06 dB';
  assert.deepEqual(parsePactlAudioStatus(volume, 'Mute: no'), { volume:50, muted:false });
  assert.deepEqual(parsePactlAudioStatus('Volume: mono: 98304 / 150% / 10.57 dB', 'Mute: yes'), { volume:100, muted:true });
  assert.throws(() => parsePactlAudioStatus('bad', 'Mute: no'), /unrecognized/i);
});

test('amixer audio status normalizes Master percentage and channel switch state', () => {
  const active = [
    "Simple mixer control 'Master',0",
    '  Front Left: Playback 32768 [50%] [-18.00dB] [on]',
    '  Front Right: Playback 32768 [50%] [-18.00dB] [on]',
  ].join('\n');
  const muted = [
    "Simple mixer control 'Master',0",
    '  Front Left: Playback 0 [0%] [-65.25dB] [off]',
    '  Front Right: Playback 0 [0%] [-65.25dB] [off]',
  ].join('\n');
  assert.deepEqual(parseAmixerAudioStatus(active), { volume:50, muted:false });
  assert.deepEqual(parseAmixerAudioStatus(muted), { volume:0, muted:true });
  assert.throws(() => parseAmixerAudioStatus('bad'), /unrecognized/i);
});

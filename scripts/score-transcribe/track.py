"""Pitch-track a practice MP3 and print a note list (time, duration, pitch)."""
import sys, numpy as np, librosa

path = sys.argv[1]
fmin = float(sys.argv[2]) if len(sys.argv) > 2 else 60
fmax = float(sys.argv[3]) if len(sys.argv) > 3 else 600
y, sr = librosa.load(path, sr=22050, mono=True)
hop = 256
f0, voiced, prob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, hop_length=hop, frame_length=2048)
rms = librosa.feature.rms(y=y, hop_length=hop, frame_length=2048)[0]
t = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop)
midi = np.where(voiced & (rms > 0.01), np.round(librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0))), -1)
# segment runs
notes = []
start = 0
for i in range(1, len(midi) + 1):
    if i == len(midi) or midi[i] != midi[start]:
        if midi[start] >= 0 and (t[i - 1] - t[start]) >= 0.08:
            notes.append((t[start], t[i - 1] - t[start] + hop / sr, int(midi[start])))
        start = i
# merge tiny gaps of same pitch
merged = []
for n in notes:
    if merged and merged[-1][2] == n[2] and n[0] - (merged[-1][0] + merged[-1][1]) < 0.06:
        s, d, p = merged[-1]
        merged[-1] = (s, n[0] + n[1] - s, p)
    else:
        merged.append(n)
for s, d, p in merged:
    print(f"{s:7.2f} {d:5.2f} {librosa.midi_to_note(p):5s}")

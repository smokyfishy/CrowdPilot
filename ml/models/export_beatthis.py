"""Export Beat This! (CPJKU, MIT) small0 to ONNX + its exact mel filterbank; validate vs PyTorch."""
import json, hashlib
import numpy as np, torch, torchaudio
import onnxruntime as ort
from beat_this.inference import load_model
from beat_this.preprocessing import LogMelSpect
from pathlib import Path
OUT = Path("public/models")
model = load_model("small0", "cpu").eval()


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__(); self.m = m
    def forward(self, spect):
        o = self.m(spect)
        return o["beat"], o["downbeat"]


w = Wrap(model).eval()
x = torch.randn(1, 1500, 128)
torch.onnx.export(w, (x,), OUT / "beat_this_small0.onnx", input_names=["spect"], output_names=["beat", "downbeat"], dynamic_axes={"spect": {1: "T"}, "beat": {1: "T"}, "downbeat": {1: "T"}}, opset_version=17, dynamo=False)
# validate on real spectrogram chunks of several lengths
lm = LogMelSpect()
import soundfile as sf
arr, sr = sf.read(json.load(open(r"C:\crowdpilot-data\raw\jamendo_eval\corpus.json"))[0]["wav"], dtype="float32", always_2d=True)
sig = torchaudio.functional.resample(torch.from_numpy(arr.mean(1)), sr, 22050)
spect = lm(sig)
sess = ort.InferenceSession(str(OUT / "beat_this_small0.onnx"), providers=["CPUExecutionProvider"])
errs = {}
for T in (1500, 731, 200):
    s = spect[:T][None]
    with torch.no_grad():
        b, d = w(s)
    ob, od = sess.run(None, {"spect": s.numpy()})
    errs[T] = {"beat_maxabs": float(np.abs(ob - b.numpy()).max()), "down_maxabs": float(np.abs(od - d.numpy()).max())}
# exact filterbank used by torchaudio MelSpectrogram (slaney, norm=None) + window normalisation
fb = lm.spect_class.mel_scale.fb.numpy().T  # (128, 513)
win = torch.hann_window(1024).numpy()
(OUT / "beat_this_melfb.json").write_text(json.dumps({"n_fft": 1024, "hop": 441, "sr": 22050, "n_mels": 128, "log_multiplier": 1000, "window_norm": float(np.sqrt((win**2).sum())), "fb": np.round(fb, 7).tolist()}))
size = (OUT / "beat_this_small0.onnx").stat().st_size
print(json.dumps({"onnx_bytes": size, "sha256": hashlib.sha256((OUT / "beat_this_small0.onnx").read_bytes()).hexdigest(), "params": sum(p.numel() for p in model.parameters()), "torch_vs_onnx": errs, "spect_frames_first_track": int(spect.shape[0])}))

/** onnxruntime-node adapter for validation/evaluation (never bundled into the app). */
import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-node'
import type { BeatNetRunner, MelBank } from '../src/dsp/beatnet'

export async function nodeBeatNet(): Promise<{ run: BeatNetRunner; bank: MelBank }> {
  const session = await ort.InferenceSession.create('public/models/beat_this_small0.onnx', { executionProviders: ['cpu'] })
  const bank = JSON.parse(readFileSync('public/models/beat_this_melfb.json', 'utf8')) as MelBank
  const run: BeatNetRunner = async (spect, frames, mels) => {
    const out = await session.run({ spect: new ort.Tensor('float32', spect, [1, frames, mels]) })
    return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array }
  }
  return { run, bank }
}

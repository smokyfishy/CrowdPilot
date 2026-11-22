/**
 * Small dense-network inference (TransitionNet), exported from PyTorch by ml/transitionnet/train.py.
 * Row-major weights: W[o * nIn + i]. Pure TypeScript; a forward pass is ~0.1 ms.
 */
export type Act = 'relu' | 'tanh' | 'sigmoid' | 'linear'

export interface Dense {
  nIn: number
  nOut: number
  W: number[]
  b: number[]
  act: Act
}

export interface MlpModel {
  kind: 'mlp'
  name: string
  version: string
  inputs: string[]
  inMean: number[]
  inStd: number[]
  trunk: Dense[]
  heads: Record<string, Dense[]>
}

function dense(l: Dense, x: Float64Array): Float64Array {
  const y = new Float64Array(l.nOut)
  for (let o = 0; o < l.nOut; o++) {
    let s = l.b[o]
    const row = o * l.nIn
    for (let i = 0; i < l.nIn; i++) s += l.W[row + i] * x[i]
    y[o] = l.act === 'relu' ? (s > 0 ? s : 0) : l.act === 'tanh' ? Math.tanh(s) : l.act === 'sigmoid' ? 1 / (1 + Math.exp(-s)) : s
  }
  return y
}

export function mlpForward(m: MlpModel, input: ArrayLike<number>): Record<string, number[]> {
  let h: Float64Array = new Float64Array(m.inputs.length)
  for (let i = 0; i < h.length; i++) {
    const v = Number.isFinite(input[i]) ? input[i] : 0
    h[i] = (v - m.inMean[i]) / (m.inStd[i] || 1)
  }
  for (const l of m.trunk) h = dense(l, h)
  const out: Record<string, number[]> = {}
  for (const [name, layers] of Object.entries(m.heads)) {
    let z: Float64Array = h
    for (const l of layers) z = dense(l, z)
    out[name] = Array.from(z)
  }
  return out
}

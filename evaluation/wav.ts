import { readFileSync } from 'node:fs'

export function readWav(path: string): { channels: Float32Array[]; rate: number } {
  const b = readFileSync(path)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let p = 12
  let fmt = { ch: 2, rate: 44100, bits: 32, tag: 3 }
  while (p < b.length - 8) {
    const id = b.toString('ascii', p, p + 4)
    const size = dv.getUint32(p + 4, true)
    if (id === 'fmt ') fmt = { tag: dv.getUint16(p + 8, true), ch: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) }
    if (id === 'data') {
      const n = Math.floor(size / (fmt.bits / 8) / fmt.ch)
      const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n))
      for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) chans[c][i] = dv.getFloat32(p + 8 + (i * fmt.ch + c) * 4, true)
      return { channels: chans, rate: fmt.rate }
    }
    p += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${path}`)
}

export function f1(ref: number[], est: number[], tol = 0.07): number {
  if (!ref.length || !est.length) return 0
  let hit = 0
  let j = 0
  const r = [...ref].sort((a, b) => a - b)
  for (const e of [...est].sort((a, b) => a - b)) {
    while (j < r.length - 1 && r[j + 1] <= e) j++
    const d = Math.min(Math.abs(r[j] - e), j + 1 < r.length ? Math.abs(r[j + 1] - e) : Infinity)
    if (d <= tol) hit++
  }
  const prec = hit / est.length
  const rec = Math.min(1, hit / r.length)
  return (2 * prec * rec) / (prec + rec || 1)
}


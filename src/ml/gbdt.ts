/**
 * Gradient-boosted tree inference (LightGBM models exported by ml/export/export_models.py into a
 * compact array form). Pure TypeScript: microseconds per prediction, no runtime download besides
 * the model JSON, identical numerics to LightGBM for finite inputs (verified by parity tests).
 */
export interface GbdtTree {
  /** Internal nodes: split feature, threshold (go left if x ≤ t), children (≥ 0 node, < 0 → leaf ~idx). */
  f: number[]
  t: number[]
  l: number[]
  r: number[]
  /** Leaf values. */
  v: number[]
}

export interface GbdtModel {
  kind: 'gbdt'
  name: string
  version: string
  objective: string
  numClass: number
  features: string[]
  trees: GbdtTree[]
}

function treeValue(tree: GbdtTree, x: ArrayLike<number>): number {
  if (!tree.f.length) return tree.v[0] ?? 0
  let n = 0
  for (let guard = 0; guard < 4096; guard++) {
    const fx = x[tree.f[n]]
    const next = (Number.isFinite(fx) ? fx : 0) <= tree.t[n] ? tree.l[n] : tree.r[n]
    if (next < 0) return tree.v[~next]
    n = next
  }
  return 0
}

/** Raw score(s): one per class (multiclass trees are interleaved by class, as LightGBM stores them). */
export function gbdtRaw(m: GbdtModel, x: ArrayLike<number>): number[] {
  const k = Math.max(1, m.numClass)
  const out = new Array<number>(k).fill(0)
  for (let i = 0; i < m.trees.length; i++) out[i % k] += treeValue(m.trees[i], x)
  return out
}

export function gbdtPredict(m: GbdtModel, x: ArrayLike<number>): number {
  const raw = gbdtRaw(m, x)
  if (m.objective.startsWith('binary')) return 1 / (1 + Math.exp(-raw[0]))
  return raw[0]
}

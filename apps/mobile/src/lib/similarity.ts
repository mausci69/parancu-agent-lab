// Cosine similarity utilities for local embedding search.
// British English comments.

export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s) || 1e-12; // avoid divide-by-zero
}

export function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b));
}

/** Normalise a vector to unit length (in-place). Returns the same array. */
export function normalise(a: number[]): number[] {
  const k = norm(a);
  for (let i = 0; i < a.length; i++) a[i] /= k;
  return a;
}

/**
 * Compute cosine similarities of a single query vector against a matrix.
 * @param q - query embedding (length d)
 * @param M - array of embeddings (N x d)
 * @returns similarities array (length N)
 */
export function cosineMatrixQuery(q: number[], M: number[][]): number[] {
  const qn = normalise([...q]);
  return M.map(v => cosine(qn, v));
}

/** Return indices of the top-K values (descending) without reallocating excessively. */
export function topKIndices(arr: number[], k: number): number[] {
  const n = arr.length;
  if (k >= n) {
    return [...arr.keys()].sort((i, j) => arr[j] - arr[i]);
  }
  // Simple partial selection (O(nk)), fine for small k on-device.
  const sel: number[] = [];
  for (let i = 0; i < n; i++) {
    const score = arr[i];
    if (sel.length < k) {
      sel.push(i);
      sel.sort((a, b) => arr[b] - arr[a]);
    } else if (score > arr[sel[sel.length - 1]]) {
      sel[sel.length - 1] = i;
      sel.sort((a, b) => arr[b] - arr[a]);
    }
  }
  return sel;
}


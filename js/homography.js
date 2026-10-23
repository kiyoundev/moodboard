// Placeholders pending the writing-space design decision (not yet made — see
// .doc/overview.md). Each returns an identity/no-op result so callers get a
// flat, undistorted panel instead of a crash, until real perspective warping
// is actually needed.

export function solveH(src, dst) {
  return [1, 0, 0, 0, 1, 0, 0, 0];
}

export function mapPt(h, x, y) {
  return [x, y];
}

export function warp(ctx, img, h, N) {
  ctx.drawImage(img, 0, 0);
}

export function rect(w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

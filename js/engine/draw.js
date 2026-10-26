/*
 * draw.js
 *
 * Renders chars[] onto the signboard canvas every frame: word-wraps and
 * lays out text, draws each character with its own size/rotation/wobble/
 * color driven by behavior energy and that character's own strike force,
 * draws the blinking caret and fading ghost particles, and auto-sizes text
 * to fit the panel. English-only — the original's Hangul line-height
 * handling is out of scope here and was dropped, not ported.
 */

import { store } from '../store.js';
import { clamp, lerp, smoothstep } from './utils.js';
import { chars, getGhosts, getShake } from './text.js';
import { moodName, getFs, getSs } from './mood.js';
import { isMicOn } from './mic.js';
import { getLastF } from './keystrokes.js';

// Flat writing panel size (not the photo) — height/width ratio 1.32, text
// wraps and sizes within this regardless of how the panel is later displayed.
const PW = 1000;
const PH = 1320;
const M = 56; // panel margin

const FONT_FAMILY = '"Helvetica Neue",Helvetica,Arial,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
const CHAR_WIDTH_MEASURE_PX = 100; // measure at a fixed large size, then scale proportionally — more stable than measuring at every actual size

const INK_COLOR = [21, 21, 21];
const RED_COLOR = [226, 35, 26];
const GHOST_COLOR = [190, 189, 185];

const FIT_RECOMPUTE_INTERVAL_S = 0.12; // how often fitSize() (an O(n) scan) gets recomputed, not every frame

const PLACEHOLDER_BG_COLOR = '#dcdcda';          // flat fallback background (no photo compositing yet)
const REDNESS_LOW = 0.32, REDNESS_HIGH = 0.78;   // store.energy range mapped onto the ink→red color shift
const PLACEHOLDER_LINES = ['Type how', 'you feel.'];
const PLACEHOLDER_FONT_SIZE = 112;
const PLACEHOLDER_LINE_TOP = 104, PLACEHOLDER_LINE_GAP = 118;
const PLACEHOLDER_CARET_BLINK_HZ = 1.6;
const PLACEHOLDER_CARET_WIDTH = 12, PLACEHOLDER_CARET_HEIGHT = 96;
const TEXT_CARET_BLINK_HZ = 1.7;
const MIN_LAST_LINE_HEIGHT = 30; // keep porting into frame budget for the last visible line

const FIT_SIZE_MAX = 270, FIT_SIZE_MIN = 92, FIT_SIZE_STEP = 6; // search range/step for the "fits without overflow" size
const FIT_MARGIN_RIGHT = 8, FIT_MARGIN_BOTTOM = 40;

const ANNOT_FONT_SIZE = 17;
const ANNOT_ROW_GAP = 21, ANNOT_LABEL_VALUE_GAP = 64;
const ANNOT_MIN_FREE_WIDTH = 210;
const ANNOT_FALLBACK_X_OFFSET = 190, ANNOT_FALLBACK_TOP = 30, ANNOT_FALLBACK_ROW_GAP = 260;
const ANNOT_HEAT_REDNESS_LOW = 0.6, ANNOT_HEAT_REDNESS_HIGH = 0.8;
const ANNOT_HOT_THRESHOLD = 0.6;

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const pctx = panel.getContext('2d');
const textarea = $('textarea');

const WCACHE = new Map();

let time = 0;
let FIT = 150, FITt = 150, fitAcc = 1;

// cached width (in em, per 1px font size) of a single character, measured
// once at a large fixed size for stability
function measureCharWidth(ch) {
  let width = WCACHE.get(ch);
  if (width == null) {
    pctx.font = `800 ${CHAR_WIDTH_MEASURE_PX}px ${FONT_FAMILY}`;
    width = pctx.measureText(ch).width / CHAR_WIDTH_MEASURE_PX;
    WCACHE.set(ch, width);
  }
  return width;
}

const mix = (colorA, colorB, t) =>
  `rgb(${colorA.map((v, i) => Math.round(v + (colorB[i] - v) * t)).join(',')})`;

// 3-sine pseudo-noise: cheap, deterministic, good enough for jitter/wobble — not real randomness
function noise(seed, phase) {
  return Math.sin(seed * 12.9898 + phase * 7.1) * 0.5
    + Math.sin(seed * 4.13 + phase * 11.3) * 0.3
    + Math.sin(seed * 1.7 + phase * 17.9) * 0.2;
}

// advances the module clock and eases FIT toward fitSize()'s latest target —
// call once per frame, before drawPanel
export function tick(dt) {
  time += dt;
  fitAcc += dt;
  if (fitAcc > FIT_RECOMPUTE_INTERVAL_S) {
    fitAcc = 0;
    FITt = fitSize();
  }
  FIT += (FITt - FIT) * (1 - Math.pow(0.02, dt));
}

// renders chars[] (word-wrapped, sized/colored by energy and per-char force)
// plus the blinking caret and fading ghost particles, onto ctx — forSave
// skips the caret for a clean still-image export
export function drawPanel(ctx, forSave) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PLACEHOLDER_BG_COLOR;
  ctx.fillRect(0, 0, PW, PH);

  const energy = store.energy;
  const textSize = store.settings.textSize;
  const redness = smoothstep(REDNESS_LOW, REDNESS_HIGH, energy);
  const fontSize = FIT * textSize * (1 + 0.85 * Math.pow(energy, 1.2)); // grows past the calm "fit" size as energy rises
  const tracking = lerp(-0.02, -0.055, energy); // letter-spacing tightens as energy rises

  const shake = getShake();
  // Screen-wide wobble: a slow energy-driven sway, plus a sharp kick from `shake` right after a hard keystroke
  const jitterX = noise(1, time) * Math.pow(energy, 3) * 7 + noise(7, time * 1.7) * shake * 9;
  const jitterY = noise(3, time) * Math.pow(energy, 3) * 5 + noise(9, time * 1.9) * shake * 7;
  ctx.save();
  ctx.translate(jitterX, jitterY);

  if (!chars.length) {
    ctx.fillStyle = 'rgba(30,30,30,.16)';
    ctx.font = `800 ${PLACEHOLDER_FONT_SIZE * textSize}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'alphabetic';
    PLACEHOLDER_LINES.forEach((line, i) => {
      ctx.fillText(line, M, M + (PLACEHOLDER_LINE_TOP + i * PLACEHOLDER_LINE_GAP) * textSize);
    });
    if (Math.floor(time * PLACEHOLDER_CARET_BLINK_HZ) % 2 === 0) {
      ctx.fillStyle = mix(INK_COLOR, RED_COLOR, redness);
      ctx.fillRect(M, M + (PLACEHOLDER_LINE_TOP + PLACEHOLDER_LINE_GAP + PLACEHOLDER_LINE_GAP) * textSize, PLACEHOLDER_CARET_WIDTH * textSize, PLACEHOLDER_CARET_HEIGHT * textSize);
    }
    ctx.restore();
    return;
  }

  // A character's own size grows with its own strike force (scaled up further as energy rises) and its "pop" bounce
  const sizeOf = (char) => fontSize * (1 + 0.48 * char.f * (0.25 + 0.75 * energy) + char.pop * 0.22);

  const maxWidth = PW - 2 * M;
  const lines = [];
  let line = [], lineWidth = 0, word = [], wordWidth = 0;

  const flushWord = () => {
    if (!word.length) return;
    if (lineWidth + wordWidth > maxWidth && line.length) {
      lines.push(line);
      line = [];
      lineWidth = 0;
      // no-op in the original too — line is always just-emptied here, so
      // this never trims anything; ported as-is, not fixed
      while (line.length && line[0].char.c === ' ') line.shift();
    }
    if (wordWidth > maxWidth) {
      for (const glyph of word) {
        if (lineWidth + glyph.width > maxWidth && line.length) { lines.push(line); line = []; lineWidth = 0; }
        line.push(glyph);
        lineWidth += glyph.width;
      }
    } else {
      for (const glyph of word) line.push(glyph);
      lineWidth += wordWidth;
    }
    word = [];
    wordWidth = 0;
  };

  for (const char of chars) {
    if (char.c === '\n') { flushWord(); lines.push(line); line = []; lineWidth = 0; continue; }
    const size = sizeOf(char);
    const width = (char.c === ' ' ? measureCharWidth(' ') * fontSize : measureCharWidth(char.c) * size) + tracking * size;
    const glyph = { char, size, width };
    if (char.c === ' ') {
      flushWord();
      if (line.length) { line.push(glyph); lineWidth += glyph.width; }
    } else {
      word.push(glyph);
      wordWidth += glyph.width;
    }
  }
  flushWord();
  lines.push(line);

  const lineHeights = lines.map((renderLine) => {
    let maxCharHeight = fontSize * 0.82;
    for (const glyph of renderLine) {
      if (glyph.char.c !== ' ') maxCharHeight = Math.max(maxCharHeight, glyph.size);
    }
    return maxCharHeight * 0.9;
  });

  // Only render as many trailing lines as fit — the newest line must always stay visible
  let firstVisible = lines.length - 1;
  let visibleHeight = lineHeights[firstVisible];
  while (firstVisible > 0 && visibleHeight + lineHeights[firstVisible - 1] <= PH - 2 * M - MIN_LAST_LINE_HEIGHT) {
    firstVisible--;
    visibleHeight += lineHeights[firstVisible];
  }

  let penY = M;
  ctx.textBaseline = 'alphabetic';
  for (const char of chars) char.x = null;

  let caretX = M, caretY = M + fontSize * 0.78, caretSize = fontSize;

  for (let lineIndex = firstVisible; lineIndex < lines.length; lineIndex++) {
    const renderLine = lines[lineIndex];
    const baseline = penY + lineHeights[lineIndex] * 0.8;
    let penX = M;
    for (const glyph of renderLine) {
      const char = glyph.char;
      if (char.c !== ' ') {
        const charIndex = chars.indexOf(char);
        // Per-character rotation and wobble, both driven by energy and this character's own strike force
        const rotationAmount = Math.pow(energy, 2) * 0.06 + char.f * energy * 0.05;
        const wobbleX = noise(charIndex, time * 1.3) * (Math.pow(energy, 2.2) * 5 + char.f * energy * 4);
        const wobbleY = noise(charIndex + 50, time * 1.1) * (Math.pow(energy, 2.2) * 5 + char.f * energy * 4);
        const charRedness = clamp(redness + char.f * 0.42 * smoothstep(0.12, 0.5, energy) - (1 - char.f) * 0.08 * redness, 0, 1);

        ctx.save();
        ctx.translate(penX + wobbleX, baseline + wobbleY);
        ctx.rotate(noise(charIndex + 90, time * 0.9) * rotationAmount);
        ctx.font = `800 ${glyph.size}px ${FONT_FAMILY}`;
        ctx.fillStyle = mix(INK_COLOR, RED_COLOR, charRedness);
        ctx.fillText(char.c, 0, 0);
        ctx.restore();

        char.x = penX; char.y = baseline; char.s = glyph.size; char.col = charRedness;
      }
      penX += glyph.width;
    }
    if (lineIndex === lines.length - 1) {
      caretX = penX;
      caretY = baseline;
      caretSize = Math.max(fontSize, renderLine.length ? renderLine[renderLine.length - 1].size : fontSize);
    }
    penY += lineHeights[lineIndex];
  }

  const caretVisible = !forSave && (document.activeElement === textarea ? Math.floor(time * TEXT_CARET_BLINK_HZ) % 2 === 0 : true);
  if (caretVisible) {
    ctx.fillStyle = mix(INK_COLOR, RED_COLOR, redness);
    ctx.fillRect(caretX + caretSize * 0.04, caretY - caretSize * 0.74, Math.max(9, caretSize * 0.085), caretSize * 0.84);
  }

  for (const ghost of getGhosts()) {
    ctx.save();
    ctx.globalAlpha = clamp(ghost.life, 0, 1) * 0.8;
    ctx.font = `800 ${ghost.s}px ${FONT_FAMILY}`;
    ctx.fillStyle = mix(GHOST_COLOR, RED_COLOR, ghost.col * 0.6);
    ctx.translate(ghost.x, ghost.y);
    ctx.rotate((1 - ghost.life) * ghost.vx * 0.004);
    ctx.fillText(ghost.c, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

// finds the largest font size that lets chars[] fit the panel without
// overflowing, by trying sizes top-down — not run every frame, see tick()
export function fitSize() {
  if (!chars.length) return FIT;
  const maxWidth = PW - 2 * M - FIT_MARGIN_RIGHT;
  const maxHeight = PH - 2 * M - FIT_MARGIN_BOTTOM;

  for (let fontSize = FIT_SIZE_MAX; fontSize >= FIT_SIZE_MIN; fontSize -= FIT_SIZE_STEP) {
    let lineWidth = 0, wordWidth = 0, height = 0;
    const lineHeight = fontSize * 1.12 * 0.9;

    for (const char of chars) {
      if (char.c === '\n') {
        if (lineWidth + wordWidth > maxWidth && lineWidth > 0) { height += lineHeight; lineWidth = wordWidth; }
        else lineWidth += wordWidth;
        wordWidth = 0;
        height += lineHeight;
        lineWidth = 0;
        continue;
      }
      const forceBoost = 1 + 0.12 * char.f; // a forcefully-typed character counts as slightly wider even before rendering
      const charWidth = (char.c === ' ' ? measureCharWidth(' ') * fontSize : measureCharWidth(char.c) * fontSize * forceBoost) - 0.02 * fontSize * forceBoost;
      if (char.c === ' ') {
        if (lineWidth + wordWidth > maxWidth && lineWidth > 0) { height += lineHeight; lineWidth = wordWidth; }
        else lineWidth += wordWidth;
        wordWidth = 0;
        lineWidth += charWidth;
      } else {
        wordWidth += charWidth;
      }
    }
    if (lineWidth + wordWidth > maxWidth && lineWidth > 0) height += lineHeight;
    height += lineHeight;

    if (height <= maxHeight) return fontSize;
  }
  return FIT_SIZE_MIN;
}

// [FIT, FITt, fitSize()] for #3.8's debug global
export function getFitDebug() {
  return [FIT, FITt, fitSize()];
}

// draws small debug text (state/force/speed/heat) next to the laid-out
// text — dead code, never called in the original either; ported faithfully
export function annot(ctx, lineLayouts) {
  const rows = [
    [['State', 'Force'], [moodName(store.energy), isMicOn() && getLastF() != null ? String(Math.round(getFs() * 100)).padStart(2, '0') : '—']],
    [['Speed', 'Heat'], [getSs().toFixed(1) + '/s', Math.round(store.energy * 100) + '°']],
  ];

  const spots = [];
  let cursorY = M;
  for (const renderLine of lineLayouts) {
    let width = 0;
    for (const glyph of renderLine.l) width += glyph.width;
    const freeWidth = PW - M - (M + width);
    if (freeWidth > ANNOT_MIN_FREE_WIDTH && spots.length < 2) spots.push([M + width + 34, cursorY + renderLine.h * 0.42]);
    cursorY += renderLine.h;
  }
  if (!spots.length) spots.push([PW - M - ANNOT_FALLBACK_X_OFFSET, M + ANNOT_FALLBACK_TOP]);
  if (spots.length < 2) spots.push([PW - M - ANNOT_FALLBACK_X_OFFSET, Math.min(PH - M - 40, spots[0][1] + ANNOT_FALLBACK_ROW_GAP)]);

  ctx.font = `500 ${ANNOT_FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  rows.forEach((row, rowIndex) => {
    const [x, startY] = spots[rowIndex];
    ctx.fillStyle = 'rgba(20,20,20,.62)';
    row[0].forEach((label, idx) => ctx.fillText(label, x, startY + idx * ANNOT_ROW_GAP));
    ctx.fillStyle = rowIndex === 0 && store.energy > ANNOT_HOT_THRESHOLD
      ? mix(INK_COLOR, RED_COLOR, smoothstep(ANNOT_HEAT_REDNESS_LOW, ANNOT_HEAT_REDNESS_HIGH, store.energy))
      : 'rgba(20,20,20,.86)';
    row[1].forEach((value, idx) => ctx.fillText(value, x + ANNOT_LABEL_VALUE_GAP, startY + idx * ANNOT_ROW_GAP));
  });
}

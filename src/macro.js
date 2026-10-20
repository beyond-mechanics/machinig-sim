// Fanuc custom macro B, the part that turns up in shop programs: variables (#1–#33 local,
// #100 and up common, #500 and up kept), #n = expression, words with #n or [expression] as their
// value, IF [cond] GOTO n / IF [cond] THEN #n = …, GOTO n, WHILE [cond] DO m … END m.
// Expressions: + − * / with the usual precedence, brackets, #[expression], functions SIN COS TAN
// ATAN (degrees) SQRT ABS ROUND FIX FUP LN EXP, comparisons EQ NE GT GE LT LE, AND OR.
// A variable never set is <vacant>: 0 in arithmetic and in GT GE LT LE, but only equal to another
// vacant in EQ NE, and a word whose value is a vacant #n is left out of the block (as on Fanuc).
// A result that is not a finite number (/0, SQRT of a negative) is an error, as the control's alarm.

const FUNCS = {
  SIN: v => Math.sin(v * Math.PI / 180), COS: v => Math.cos(v * Math.PI / 180), TAN: v => Math.tan(v * Math.PI / 180),
  ATAN: v => Math.atan(v) * 180 / Math.PI, ATN: v => Math.atan(v) * 180 / Math.PI, SQRT: Math.sqrt, SQR: Math.sqrt,
  ABS: Math.abs, ROUND: v => Math.sign(v) * Math.round(Math.abs(v)), RND: v => Math.sign(v) * Math.round(Math.abs(v)), FIX: Math.trunc, FUP: v => (v < 0 ? Math.floor(v) : Math.ceil(v)), LN: Math.log, EXP: Math.exp,
};
const z = v => v ?? 0;   // vacant → 0
const CMP = { EQ: (a, b) => a === b, NE: (a, b) => a !== b, GT: (a, b) => z(a) > z(b), GE: (a, b) => z(a) >= z(b), LT: (a, b) => z(a) < z(b), LE: (a, b) => z(a) <= z(b) };
const finite = (v, src) => { if (v !== null && !Number.isFinite(v)) throw new Error(`計算できない値 (0 での割り算など): ${src}`); return v; };

function tokens(s) {
  const out = [];
  const re = /\s*(\d*\.\d+|\d+\.?|[A-Z]+|[#[\]+\-*/,=])/gy;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    if (/^\s*$/.test(s.slice(re.lastIndex))) break;
    m = re.exec(s);
    if (!m) throw new Error(`読めない式: ${s}`);
    out.push(m[1]);
  }
  return out;
}

// evaluate an expression string; vars: Map. Returns null for a lone vacant variable.
export function evalExpr(src, vars) {
  const t = tokens(src);
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const expect = v => { if (t[i] !== v) throw new Error(`「${v}」がありません: ${src}`); i++; };
  function primary() {
    const k = next();
    if (k === undefined) throw new Error(`式が途中で終わっています: ${src}`);
    if (k === '-') return -z(primary());
    if (k === '+') return z(primary());
    if (k === '[') { const v = or(); expect(']'); return v; }
    if (k === '#') { const n = peek() === '[' ? (next(), (() => { const v = or(); expect(']'); return v; })()) : +next(); const r = Math.round(z(n)); return r === 0 ? null : vars.get(r) ?? null; }
    if (FUNCS[k]) { expect('['); const v = or(); expect(']'); return finite(FUNCS[k](z(v)), src); }
    if (/^[\d.]/.test(k)) return parseFloat(k);
    throw new Error(`読めない式: ${src}`);
  }
  function term() { let v = primary(); while (peek() === '*' || peek() === '/') v = finite(next() === '*' ? z(v) * z(primary()) : z(v) / z(primary()), src); return v; }
  function sum() { let v = term(); while (peek() === '+' || peek() === '-') v = next() === '+' ? z(v) + z(term()) : z(v) - z(term()); return v; }
  function cmp() { let v = sum(); while (CMP[peek()]) { const op = next(); v = CMP[op](v, sum()) ? 1 : 0; } return v; }
  function and() { let v = cmp(); while (peek() === 'AND') { next(); const b = cmp(); v = z(v) && z(b) ? 1 : 0; } return v; }
  function or() { let v = and(); while (peek() === 'OR') { next(); const b = and(); v = z(v) || z(b) ? 1 : 0; } return v; }
  const v = or();
  if (i < t.length) throw new Error(`式の後ろに余計なもの: ${src}`);
  return v;
}

// the bracketed expression starting at s[i] === '[' → [inner text, index after the closing ']']
function bracket(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) { if (s[j] === '[') d++; else if (s[j] === ']' && --d === 0) return [s.slice(i + 1, j), j + 1]; }
  throw new Error(`「]」がありません: ${s}`);
}
const num = v => (Number.isInteger(v) ? `${v}.0` : v.toFixed(4).replace(/0+$/, ''));

// a block with its #-variables and [expressions] replaced by numbers (word values only)
export function substitute(line, vars) {
  let out = '', i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '#' || c === '[') {
      // the sign written before it belongs to the value
      let sign = 1;
      if (out.endsWith('-')) { sign = -1; out = out.slice(0, -1); } else if (out.endsWith('+')) out = out.slice(0, -1);
      let v;
      if (c === '[') { const [e, j] = bracket(line, i); v = z(evalExpr(e, vars)); i = j; }
      else if (line[i + 1] === '[') { const [e, j] = bracket(line, i + 1); v = vars.get(Math.round(z(evalExpr(e, vars)))); i = j; }
      else { const m = line.slice(i + 1).match(/^\d+/); if (!m) throw new Error(`変数番号がありません: ${line}`); v = +m[0] ? vars.get(+m[0]) : undefined; i += 1 + m[0].length; }
      // a vacant variable as a word's value: the word is left out
      if (v === undefined || v === null) { const a = out.match(/[A-Z]\s*$/); if (a) { out = out.slice(0, a.index); continue; } v = 0; }
      out += num(sign * v);
    } else { out += c; i++; }
  }
  return out;
}

// One macro statement. Returns null for an ordinary block (after substitution: { block }),
// or { assign } / { goto: n } / { whileFalse: m } / { loopEnd: m } / { skip } for statements.
export function macroStatement(line, vars) {
  let m;
  // N-number before a statement
  const body = line.replace(/^N\s*\d+\s*/, '');
  if ((m = body.match(/^#\s*(\d+|\[.*\])\s*=\s*(.+)$/))) {
    const n = /^\d+$/.test(m[1]) ? +m[1] : Math.round(z(evalExpr(m[1].slice(1, -1), vars)));
    if (n === 0) throw new Error('#0 (空) には代入できません');
    const v = evalExpr(m[2], vars);
    if (v === null) vars.delete(n); else vars.set(n, v);
    return { assign: n };
  }
  if ((m = body.match(/^IF\s*(\[.*\])\s*(GOTO\s*(.+)|THEN\s*(.+))$/))) {
    const [cond] = bracket(m[1], 0);
    if (!z(evalExpr(cond, vars))) return { skip: true };
    if (m[3] !== undefined) return { goto: Math.round(z(evalExpr(m[3], vars))) };
    return macroStatement(m[4], vars) || { skip: true };
  }
  if ((m = body.match(/^GOTO\s*(.+)$/))) return { goto: Math.round(z(evalExpr(m[1], vars))) };
  if ((m = body.match(/^WHILE\s*(\[.*\])\s*DO\s*(\d+)$/))) {
    const [cond] = bracket(m[1], 0);
    return z(evalExpr(cond, vars)) ? { loopStart: +m[2] } : { whileFalse: +m[2] };
  }
  if ((m = body.match(/^END\s*(\d+)$/))) return { loopEnd: +m[1] };
  return null;
}

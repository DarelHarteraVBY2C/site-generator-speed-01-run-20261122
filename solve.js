// Swift Site — a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns the output tree makefun-site 1.0.0 builds for the same
// input, byte for byte: every page's index.html, the index and tag pages,
// build-report.txt and each static file. It is written from the dialect's own
// specification (front matter, template dialect, Markdown subset, slug rule,
// report) as a single-pass implementation:
//
//   - no line arrays: bodies are scanned by index, one pass, block by block;
//   - no per-character regular expressions on the hot paths: plain runs are
//     escaped in bulk, and the Markdown lexer tests lines with small manual
//     checks instead of a regex per line;
//   - templates are parsed once per case and walked with an output buffer;
//   - slugs are memoised per case and take an ASCII fast path.
//
// The input is { site, templates, files }; the output is { path: text }.
// A build reads no clock, no environment, no randomness and no file.

// ---------------------------------------------------------------- text

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `s` with & < > " and ' escaped. */
function escText(s) {
  return s.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether the code unit is one of JavaScript's whitespace characters. */
function isWsCode(c) {
  if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) return true;
  if (c === 160 || c === 5760 || c === 8239 || c === 8287 || c === 12288 || c === 65279) return true;
  if (c >= 8192 && c <= 8202) return true;
  return c === 8232 || c === 8233;
}

/** The words of `t`: its runs of characters other than whitespace. */
function countWords(t) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) {
      inWord = false;
      continue;
    }
    if (c < 128) {
      if (!inWord) { inWord = true; n++; }
      continue;
    }
    if (isWsCode(c)) {
      inWord = false;
      continue;
    }
    if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** Whether `s` holds any whitespace character. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_LIMIT = 64;

/** A slug cut to its limit (a "-" left at the cut dropped), or "untitled". */
function finishSlug(out) {
  let end = out.length > SLUG_LIMIT ? SLUG_LIMIT : out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  const cut = out.slice(0, end);
  return cut === '' ? 'untitled' : cut;
}

const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end. Results
 * are memoised in `memo`, which lives for one case only. Plain ASCII text
 * skips the normalisation step entirely.
 */
function slugOf(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const cp = plain.codePointAt(i);
    if (cp > 0xffff) i++;
    let keep = -1;
    if (cp >= 65 && cp <= 90) keep = cp + 32;
    else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) keep = cp;
    if (keep < 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCodePoint(keep);
  }
  const slug = finishSlug(out);
  memo.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function takeSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  const out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The directory of a path ("" at the root). */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A two-digit number at `s[i..i+1]`, or -1 when either character is no digit. */
function twoDigits(s, i) {
  const a = s.charCodeAt(i) - 48;
  const b = s.charCodeAt(i + 1) - 48;
  return a < 0 || a > 9 || b < 0 || b > 9 ? -1 : a * 10 + b;
}

/** A four-digit number at `s[i..i+3]`, or -1 when any character is no digit. */
function fourDigits(s, i) {
  let v = 0;
  for (let k = 0; k < 4; k++) {
    const d = s.charCodeAt(i + k) - 48;
    if (d < 0 || d > 9) return -1;
    v = v * 10 + d;
  }
  return v;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare rest of the line. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function fmDate(raw) {
  const bad = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return { error: bad };
  const y = fourDigits(raw, 0);
  const mo = twoDigits(raw, 5);
  const d = twoDigits(raw, 8);
  if (y < 0 || mo < 0 || d < 0) return { error: bad };
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return { error: bad };
  return { value: raw };
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding " [ ]. */
function fmTags(raw) {
  if (raw.length < 2 || raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const parts = inner.split(',');
  const tags = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    for (let j = 0; j < t.length; j++) {
      const c = t[j];
      if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags.push(t);
  }
  return { value: tags };
}

/** Whether `raw` is a template name (a-z, 0-9 and "-"). */
function fmName(raw) {
  if (raw === '') return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug (a-z and 0-9, single "-" between), at most 64 characters. */
function fmSlug(raw) {
  if (raw === '' || raw.length > 64) return false;
  if (raw[0] === '-' || raw[raw.length - 1] === '-') return false;
  let prevDash = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return fmDate(raw);
    case 'tags':
      return fmTags(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return fmName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return fmSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front-matter line, `text[a..b)`, checked into `data`: null when it is
 * fine, else the reason the source is refused. `lineNo` counts from 1 at the
 * opening "---".
 */
function fmLine(data, text, a, b, lineNo) {
  let blank = true;
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) { blank = false; break; }
  }
  if (blank) return null;
  if (text.charCodeAt(a) === 35) return null; // a comment opens on "#"
  let k = a;
  while (k < b) {
    const c = text.charCodeAt(k);
    if (!((c >= 97 && c <= 122) || c === 95)) break;
    k++;
  }
  if (k === a || k >= b || text.charCodeAt(k) !== 58) return `line ${lineNo} is not "key: value"`;
  const key = text.slice(a, k);
  let raw;
  if (k + 1 === b) raw = '';
  else if (text.charCodeAt(k + 1) === 32) {
    let e = b;
    while (e > k + 2 && (text.charCodeAt(e - 1) === 32 || text.charCodeAt(e - 1) === 9)) e--;
    raw = text.slice(k + 2, e);
  } else return `line ${lineNo} is not "key: value"`;
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = fmValue(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const n = text.length;
  let e0 = text.indexOf('\n');
  if (e0 < 0) e0 = n;
  if (e0 !== 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') return { error: 'no front matter' };
  // First find the closing line, so a file with no close is refused for that
  // before any of its lines is judged.
  let closeEnd = -1;
  let closeNo = -1;
  let p = e0 + 1;
  let no = 1;
  while (p <= n) {
    let e = text.indexOf('\n', p);
    if (e < 0) e = n;
    if (e - p === 3 && text[p] === '-' && text[p + 1] === '-' && text[p + 2] === '-') {
      closeEnd = e;
      closeNo = no;
      break;
    }
    if (e === n) break;
    p = e + 1;
    no++;
  }
  if (closeNo < 0) return { error: 'the front matter is not closed' };
  const data = {};
  p = e0 + 1;
  for (let ln = 1; ln < closeNo; ln++) {
    let e = text.indexOf('\n', p);
    if (e < 0) e = n;
    const err = fmLine(data, text, p, e, ln + 1);
    if (err !== null) return { error: err };
    p = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === n ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes inline. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether the line `s[a..b)` holds only spaces and tabs. */
function lineBlank(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the range `s[a..b)` holds only spaces and tabs. */
function onlySpaces(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The line `s[a..b)`, trimmed of spaces and tabs at both ends. */
function trimText(s, a, b) {
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/**
 * A fence opening line: three backticks and an optional language, then spaces
 * or tabs only. Returns the language ("" when there is none), or null.
 */
function fenceLang(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(a + 3, i);
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether the line `s[a..b)` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading line: 1 to 6 "#", at least one space or tab, then text (spaces
 * and tabs at its end dropped). Returns { depth, start, end } or null when
 * the line is no heading (its text would be empty, or 7 or more "#").
 */
function headingAt(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) === 35) i++;
  const depth = i - a;
  if (depth === 0 || depth > 6) return null;
  if (i >= b) return null;
  const c = s.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  let t0 = i;
  while (t0 < b && (s.charCodeAt(t0) === 32 || s.charCodeAt(t0) === 9)) t0++;
  let t1 = b;
  while (t1 > t0 && (s.charCodeAt(t1 - 1) === 32 || s.charCodeAt(t1 - 1) === 9)) t1--;
  if (t1 === t0) return null;
  return { depth, start: t0, end: t1 };
}

/** Whether the line `s[a..b)` is a thematic break: "---" or "***", then spaces or tabs only. */
function isRule(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a);
  const c1 = s.charCodeAt(a + 1);
  const c2 = s.charCodeAt(a + 2);
  if (!((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42))) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet line "- " or "* ": the index its item's text starts at, or -1. */
function bulletAt(s, a, b) {
  if (b - a < 2) return -1;
  const c = s.charCodeAt(a);
  if ((c === 45 || c === 42) && s.charCodeAt(a + 1) === 32) return a + 2;
  return -1;
}

/**
 * An ordered line "12. ": { num, text } with the digits and the index its
 * item's text starts at, or null. At most 9 digits.
 */
function orderedAt(s, a, b) {
  let i = a;
  let digits = 0;
  while (i < b && digits < 9) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
    digits++;
  }
  if (digits === 0) return null;
  if (i + 1 >= b || s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== 32) return null;
  return { num: s.slice(a, i), text: i + 2 };
}

/** Whether the line `s[a..b)` continues a list item: two or more spaces, then a non-space. */
function continuedAt(s, a, b) {
  if (b - a < 3) return false;
  if (s.charCodeAt(a) !== 32 || s.charCodeAt(a + 1) !== 32) return false;
  let i = a + 2;
  while (i < b && s.charCodeAt(i) === 32) i++;
  if (i >= b) return false;
  return !isWsCode(s.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single "*" from `from` (one whose run is not "**"), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. Plain runs are
 * collected and escaped in bulk, so a body of ordinary prose costs one escape
 * per run instead of one per character — and a run holding no HTML special is
 * not escaped at all: the scan already looks at every character, so it notes
 * the specials (a small table, `SPEC`) as it goes.
 */
const SPEC = new Uint8Array(128);
SPEC[34] = 1;
SPEC[38] = 1;
SPEC[39] = 1;
SPEC[60] = 1;
SPEC[62] = 1;

function inlineMd(s, link) {
  let out = '';
  const n = s.length;
  let i = 0;
  let run = 0;
  let dirty = false;
  while (i < n) {
    const code = s.charCodeAt(i);
    if (code === 92 && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (i > run) out += dirty ? escText(s.slice(run, i)) : s.slice(run, i);
      out += escText(s[i + 1]);
      i += 2;
      run = i;
      dirty = false;
      continue;
    }
    if (code === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out += dirty ? escText(s.slice(run, i)) : s.slice(run, i);
        out += `<code>${escText(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        run = i;
        dirty = false;
      } else i++;
      continue;
    }
    if (code === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out += dirty ? escText(s.slice(run, i)) : s.slice(run, i);
          out += `<strong>${inlineMd(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
          run = i;
          dirty = false;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > run) out += dirty ? escText(s.slice(run, i)) : s.slice(run, i);
        out += `<em>${inlineMd(s.slice(i + 1, j), link)}</em>`;
        i = j + 1;
        run = i;
        dirty = false;
      } else i++;
      continue;
    }
    if (code === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        if (i > run) out += dirty ? escText(s.slice(run, i)) : s.slice(run, i);
        out += `<a href="${escText(link(target))}">${inlineMd(s.slice(i + 1, k), link)}</a>`;
        i = m + 1;
        run = i;
        dirty = false;
        continue;
      }
      i++;
      continue;
    }
    if (code < 128 && SPEC[code] === 1) dirty = true;
    i++;
  }
  if (n > run) out += dirty ? escText(s.slice(run, n)) : s.slice(run, n);
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level,
 * id and its inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or ""). `link` resolves a link's href; `memo` is the case's slug cache.
 */
function renderBody(src, link, memo) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const out = [];
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    let eol = src.indexOf('\n', pos);
    if (eol < 0) eol = n;
    const a = pos;
    const b = eol;
    const nxt = eol < n ? eol + 1 : n;
    // A block's kind is fixed by its first character: a fence, heading,
    // break, quote or list marker must sit at column zero, so any other
    // first character (or an indented line) can only be a paragraph line.
    // Dispatching on it skips a check per line for every other kind.
    const fc = a < b ? src.charCodeAt(a) : -1;
    if (fc === 32 || fc === 9) {
      if (lineBlank(src, a, b)) {
        pos = nxt;
        continue;
      }
    } else if (fc === 96) {
      const lang = fenceLang(src, a, b);
      if (lang !== null) {
        const cls = lang === '' ? '' : ` class="language-${escText(lang)}"`;
        const code = [];
        pos = nxt;
        while (pos < n) {
          let e2 = src.indexOf('\n', pos);
          if (e2 < 0) e2 = n;
          if (fenceClose(src, pos, e2)) {
            pos = e2 < n ? e2 + 1 : n;
            break;
          }
          code.push(src.slice(pos, e2));
          pos = e2 < n ? e2 + 1 : n;
        }
        // "\n" is no HTML special, so the whole block escapes as one run.
        const body = code.length === 0 ? '' : `${escText(code.join('\n'))}\n`;
        out.push(`<pre><code${cls}>${body}</code></pre>\n`);
        continue;
      }
    } else if (fc === 35) {
      const hd = headingAt(src, a, b);
      if (hd !== null) {
        const text = src.slice(hd.start, hd.end);
        const id = takeSlug(slugOf(text, memo), ids);
        const html = inlineMd(text, link);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        pos = nxt;
        continue;
      }
    } else if (fc === 45 || fc === 42) {
      if (isRule(src, a, b)) {
        out.push('<hr>\n');
        pos = nxt;
        continue;
      }
    } else if (fc === 62) {
      const lines = [];
      while (pos < n) {
        let e2 = src.indexOf('\n', pos);
        if (e2 < 0) e2 = n;
        if (src.charCodeAt(pos) !== 62) break;
        let s2 = pos + 1;
        if (src.charCodeAt(s2) === 32) s2++;
        const t = trimText(src, s2, e2);
        if (t !== '') lines.push(t);
        pos = e2 < n ? e2 + 1 : n;
      }
      if (lines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inlineMd(lines.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    } else if (fc === -1) {
      pos = nxt;
      continue;
    }
    // A list: its first line fixes the marker kind (bullet, or ordered with
    // its start number); later lines of the same kind are more items, and a
    // line of two or more spaces then a non-space continues the item.
    let listText = -1;
    let listOrdered = false;
    let listStart = 1;
    if (fc === 45 || fc === 42) {
      const bl = bulletAt(src, a, b);
      if (bl >= 0) listText = bl;
    } else if (fc >= 48 && fc <= 57) {
      const ol = orderedAt(src, a, b);
      if (ol !== null) {
        listOrdered = true;
        listStart = Number(ol.num);
        listText = ol.text;
      }
    }
    if (listText >= 0) {
      const ordered = listOrdered;
      const items = [trimText(src, listText, b)];
      const start = listStart;
      pos = nxt;
      while (pos < n) {
        let e2 = src.indexOf('\n', pos);
        if (e2 < 0) e2 = n;
        let m = -1;
        let om = null;
        if (ordered) om = orderedAt(src, pos, e2);
        else m = bulletAt(src, pos, e2);
        if ((!ordered && m >= 0) || (ordered && om !== null)) {
          items.push(trimText(src, ordered ? om.text : m, e2));
          pos = e2 < n ? e2 + 1 : n;
        } else if (continuedAt(src, pos, e2)) {
          const last = items.length - 1;
          items[last] += `\n${trimText(src, pos, e2)}`;
          pos = e2 < n ? e2 + 1 : n;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (let i = 0; i < items.length; i++) inner += `<li>${inlineMd(items[i], link)}</li>\n`;
      out.push(`${open}\n${inner}</${tag}>\n`);
      continue;
    }
    // A paragraph: the lines after the first, up to a blank line, a fence, a
    // heading or a thematic break (a quote or list line does not end it).
    // Each line is trimmed of spaces and tabs at both ends, and the lines are
    // joined by "\n".
    const parts = [trimText(src, a, b)];
    pos = nxt;
    while (pos < n) {
      let e2 = src.indexOf('\n', pos);
      if (e2 < 0) e2 = n;
      const fc2 = pos < e2 ? src.charCodeAt(pos) : 10;
      let ends = false;
      if (fc2 === 10) ends = true;
      else if (fc2 === 32 || fc2 === 9) ends = lineBlank(src, pos, e2);
      else if (fc2 === 96) ends = fenceLang(src, pos, e2) !== null;
      else if (fc2 === 35) ends = headingAt(src, pos, e2) !== null;
      else if (fc2 === 45 || fc2 === 42) ends = isRule(src, pos, e2);
      if (ends) break;
      parts.push(trimText(src, pos, e2));
      pos = e2 < n ? e2 + 1 : n;
    }
    const html = inlineMd(parts.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/**
 * A template that does not parse: its name and why. A template that fails to
 * parse is reported and left out, as if it were not there.
 */
class TplError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** The deepest an include nests: one past it renders nothing. */
const MAX_INCLUDE = 8;

/** The path `text` names, split at its dots, or a TplError. */
function tplPath(name, text) {
  if (!PATH_RE.test(text)) throw new TplError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: text, {{ }}, {{{ }}} and {% %}. A {% %} tag alone on its
 * line (only spaces or tabs beside it) takes its whole line with it, its
 * newline included.
 */
function tplTokens(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const triple = src[open + 2] === '{';
      const close = src.indexOf(triple ? '}}}' : '}}', open + (triple ? 3 : 2));
      if (close === -1) throw new TplError(`template "${name}": a ${triple ? '{{{' : '{{'} is not closed`);
      if (text !== '') {
        toks.push({ t: 'text', text });
        text = '';
      }
      toks.push({ t: triple ? 'raw' : 'var', path: tplPath(name, src.slice(open + (triple ? 3 : 2), close).trim()) });
      i = close + (triple ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const ls = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const le = nl === -1 ? src.length : nl;
    const alone = onlySpaces(src, ls, open) && onlySpaces(src, end, le);
    if (alone) text = text.slice(0, text.length - (open - ls));
    if (text !== '') {
      toks.push({ t: 'text', text });
      text = '';
    }
    toks.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = alone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push({ t: 'text', text });
  return toks;
}

/** `src` parsed into its tree of nodes (a TplError when it does not parse). */
function parseTpl(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokens(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: tplPath(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: tplPath(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.els !== null) throw new TplError(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TplError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.els !== null ? parent.els : parent.then);
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TplError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TplError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope chain: its first name from the nearest
 * scope holding it, then own properties. Scopes are null-prototype frames, so
 * a missing name reads undefined rather than something inherited.
 */
function lookupPath(scope, path) {
  for (let i = scope.length - 1; i >= 0; i--) {
    const frame = scope[i];
    const first = frame[path[0]];
    if (first === undefined) continue;
    let v = first;
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += valueText(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `scope` (a chain of frames, nearest last).
 * `templates` holds the parsed templates; `depth` counts include nesting.
 * `out` is a plain array of chunks, joined once by the caller: the joined
 * string is flat, which is also what JSON.stringify reads fastest.
 * A for loop reuses one frame and one loop record for its whole run, updating
 * them per item, instead of allocating a scope per item.
 */
function renderList(nodes, scope, templates, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    if (node.kind === 'text') {
      out.push(node.text);
      continue;
    }
    if (node.kind === 'var') {
      out.push(escText(valueText(lookupPath(scope, node.path))));
      continue;
    }
    if (node.kind === 'raw') {
      out.push(valueText(lookupPath(scope, node.path)));
      continue;
    }
    if (node.kind === 'if') {
      const v = isTruthy(lookupPath(scope, node.path));
      const branch = v !== node.not ? node.then : node.els;
      if (branch !== null) renderList(branch, scope, templates, depth, out);
      continue;
    }
    if (node.kind === 'for') {
      const xs = lookupPath(scope, node.path);
      if (!Array.isArray(xs) || xs.length === 0) continue;
      const frame = Object.create(null);
      const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
      frame.loop = loop;
      scope.push(frame);
      for (let k = 0; k < xs.length; k++) {
        frame[node.name] = xs[k];
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === xs.length - 1;
        renderList(node.body, scope, templates, depth, out);
      }
      scope.pop();
      continue;
    }
    if (node.kind === 'include') {
      const t = templates.get(node.name);
      if (t !== undefined && depth < MAX_INCLUDE) renderList(t, scope, templates, depth + 1, out);
      continue;
    }
  }
}

// ---------------------------------------------------------------- the build

/** A link's href: a target with a scheme, opening on "/" or "#", is kept as written; any other is a path from the source's directory. */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolveLink(target, dir, srcPath, base, bySource, staticPaths, broken) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolveRel(dir, rel);
  if (path !== null) {
    const page = bySource.get(path);
    if (page !== undefined) return `${page.url}${frag}`;
    if (staticPaths.has(path)) return `${base}/${path}${frag}`;
  }
  broken.add(`broken-link ${srcPath} -> ${target}`);
  return target;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED_DIRS = ['posts', 'tags', 'page'];

/**
 * One site's output tree: path -> text. The build runs in order: sources,
 * front matter, permalinks, Markdown, collections, tags, layouts, report.
 */
export function run(input) {
  const memo = new Map(); // the case's slug cache, fresh for every case
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplError) report.push(err.message);
      else throw err;
    }
  }

  // Sources, in code-unit order of path, line ends made "\n"; a file that is
  // not .md is static.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // Most sources already end their lines with "\n": only normalise when
      // a "\r" is actually there, so the replace is skipped for most files.
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a
  // draft. The checks run in order, and the first one that fails is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.isPost = s.path.startsWith('posts/');
    let own = null;
    for (const d of RESERVED_DIRS) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.isPost && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.isPost ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug made unique in
  // its directory, in source order.
  const bySource = new Map();
  const takenByDir = new Map();
  for (const s of kept) {
    const dir = s.isPost ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    const slug = takeSlug(s.data.slug ?? slugOf(s.data.title, memo), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => resolveLink(target, dir, s.path, base, bySource, staticPaths, broken);
    const md = renderBody(s.body, link, memo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug; each post's
  // newer and older neighbours.
  const posts = kept.filter((s) => s.isPost);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met in the posts' order,
  // ordered by count of posts, most first, then by slug.
  const tagBySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const list = s.data.tags ?? [];
    for (let i = 0; i < list.length; i++) {
      const slug = slugOf(list[i], memo);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(list[i]);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugOf(name, memo);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.isPost) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const slug = slugOf(name, memo);
      return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The views templates read: a card, a page, a neighbour link, a tag.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const pageOf = (s) => ({
    ...(s.isPost ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.isPost,
  });
  const tagView = (t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map((p) => cards.get(p)),
  });

  // Layouts: every page through its layout, the index pages and the tag
  // pages through theirs, then each static file at its own path unless a
  // built page has that path.
  const siteView = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, extra) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const vars = Object.create(null);
    vars.site = siteView;
    vars.tags = allTags;
    vars.recent = recent;
    Object.assign(vars, extra);
    const out = [];
    renderList(nodes, [vars], templates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagView(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.filter((s) => !s.isPost).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}


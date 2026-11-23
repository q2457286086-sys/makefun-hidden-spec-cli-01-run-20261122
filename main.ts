// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit recorded, as [old path, new path], in patch order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}


// ---- SPEC.md section 5: a file's lines, and matching old lines against them. ----

/** Split a file's text into its lines, its line break, and whether it ends with one. */
function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** Join lines back with the file's own break, ending with one exactly when it did. */
function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Whether a file line matches a patch line at a tier: 0 exact, 1 trailing whitespace ignored, 2 both ends ignored. */
function tierMatch(f: string, o: string, tier: number): boolean {
  if (tier === 0) return f === o;
  if (tier === 1) return trimEndWs(f) === trimEndWs(o);
  return trimWs(f) === trimWs(o);
}

/** Every position where O occurs in lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierMatch(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier where O occurs (tier 0 only when strict), and its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Old lines O and new lines N of one replacement, with each context line of N tied to its line of O. */
interface LinesPair {
  o: string[];
  n: string[];
  /** For each line of N, its index in O when it is a context line, else -1. */
  nCtx: number[];
}

/**
 * Build N as written: a context line is the file's own matched line, never the patch's; at tier 2 a
 * line that is not empty, not only whitespace, and starts with the leading whitespace of O's first line
 * has that prefix replaced by the leading whitespace of the file's first matched line.
 */
function buildN(lines: string[], pair: LinesPair, pos: number, tier: number): string[] {
  const out: string[] = [];
  const p = pair.o.length > 0 ? leadWs(pair.o[0]!) : '';
  const f = pair.o.length > 0 ? leadWs(lines[pos]!) : '';
  for (let j = 0; j < pair.n.length; j += 1) {
    const ci = pair.nCtx[j]!;
    if (ci >= 0) {
      out.push(lines[pos + ci]!);
      continue;
    }
    const text = pair.n[j]!;
    if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(p)) out.push(f + text.slice(p.length));
    else out.push(text);
  }
  return out;
}

/** Replace lines[pos .. pos + oLen) by n. */
function spliceLines(lines: string[], pos: number, oLen: number, n: string[]): string[] {
  return [...lines.slice(0, pos), ...n, ...lines.slice(pos + oLen)];
}

// ---- SPEC.md section 6: unified diffs. ----

type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

interface Hunk {
  /** The old start line from the header (1-based). */
  a: number;
  o: string[];
  n: string[];
  nCtx: number[];
  /** Whether a backslash line follows the hunk's last context or `+` line. */
  backslash: boolean;
  /** Whether a backslash line follows the hunk's last `+` line. */
  plusBackslash: boolean;
}

interface UnifiedSection {
  /** Null when the path is /dev/null (no file). */
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const stripOnePrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
const devNull = (p: string | null): string | null => (p === '/dev/null' ? null : p);

/** Finish a hunk body: drop trailing empty context lines, split it into O and N, note the backslash rule. */
function finishHunk(a: number, items: BodyItem[]): Hunk {
  const kept = [...items];
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') kept.pop();
    else break;
  }
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const it of kept) {
    if (it.kind === 'ctx') {
      const oi = o.length;
      o.push(it.text);
      n.push(it.text);
      nCtx.push(oi);
    } else if (it.kind === 'old') o.push(it.text);
    else if (it.kind === 'new') {
      n.push(it.text);
      nCtx.push(-1);
    }
  }
  let backslash = false;
  let plusBackslash = false;
  for (let k = kept.length - 1; k >= 0; k -= 1) {
    const it = kept[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') {
      backslash = kept[k + 1]?.kind === 'bs';
      break;
    }
  }
  for (let k = kept.length - 1; k >= 0; k -= 1) {
    const it = kept[k]!;
    if (it.kind === 'new') {
      plusBackslash = kept[k + 1]?.kind === 'bs';
      break;
    }
  }
  return { a, o, n, nCtx, backslash, plusBackslash };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const diffGit = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let curHunk: { a: number; items: BodyItem[] } | null = null;
  const endHunk = (): void => {
    if (curHunk !== null && cur !== null) cur.hunks.push(finishHunk(curHunk.a, curHunk.items));
    curHunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (curHunk !== null) {
      // Inside a hunk body: it ends at a new section, a new hunk, or any other line.
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) || l.startsWith('@@')) {
        endHunk();
      } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        if (l === '') curHunk.items.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') curHunk.items.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') curHunk.items.push({ kind: 'old', text: l.slice(1) });
        else if (l[0] === '+') curHunk.items.push({ kind: 'new', text: l.slice(1) });
        else curHunk.items.push({ kind: 'bs', text: l });
        i += 1;
        continue;
      } else {
        endHunk();
      }
    }
    if (l.startsWith('diff --git ')) {
      const m = diffGit.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = devNull(stripOnePrefix(l.slice(4).split('\t')[0]!.trim()));
      const newP = devNull(stripOnePrefix(lines[i + 1]!.slice(4).split('\t')[0]!.trim()));
      if (cur === null || cur.hunks.length > 0) {
        cur = { oldPath: oldP, newPath: newP, create: false, del: false, hunks: [] };
        sections.push(cur);
      } else {
        cur.oldPath = oldP;
        cur.newPath = newP;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      // A `--- ` line not followed by `+++ `, inside a section's header.
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkHead.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: Number(m[1]), items: [] };
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  endHunk();
  return sections.map((sec) => (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.create || oldP === null) {
      const p = newP ?? '';
      if (p === '') throw new Fail('unsafe', '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (let k = 0; k < h.n.length; k += 1) {
          // A `+` line is a new line only when it is not a context line.
          if (h.nCtx[k] === -1) {
            plus.push(h.n[k]!);
            hasPlus = true;
          }
        }
        // The section's last `+` line: a backslash after it drops the final break.
        if (hasPlus) finalBreak = !h.plusBackslash;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (sec.del || newP === null) {
      const p = oldP ?? '';
      if (p === '') throw new Fail('unsafe', '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const isMove = newP !== p;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let { lines: fl, br, final } = fileLines(before);
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        const insertAt = Math.max(0, Math.min(h.a + d, fl.length));
        const atEnd = insertAt === fl.length;
        const n = buildN(fl, h, insertAt, 0);
        fl = spliceLines(fl, insertAt, 0, n);
        if (atEnd) final = !h.backslash;
        d += h.n.length - h.o.length;
      } else {
        const found = findTier(fl, h.o, strict);
        if (found === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const q of found.positions) {
          if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
        }
        const atEnd = pos + h.o.length === fl.length;
        const n = buildN(fl, h, pos, found.tier);
        fl = spliceLines(fl, pos, h.o.length, n);
        if (atEnd) final = !h.backslash;
        d += h.n.length - h.o.length;
      }
    }
    const out = joinLines(fl, br, final);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP, out);
      tree.moves.push([p, newP]);
    } else {
      tree.now.set(p, out);
    }
  });
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks. ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    searchLine: number;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j -= 1) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, searchLine, old: lines.slice(i + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    const before = tree.get(b.path);
    if (b.old.length === 0) {
      if (before !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    if (before === null) throw new Fail('missing', b.path);
    const { lines: fl, br, final } = fileLines(before);
    const found = findTier(fl, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const pair: LinesPair = { o: b.old, n: b.nw, nCtx: b.nw.map(() => -1) };
    const n = buildN(fl, pair, pos, found.tier);
    tree.now.set(b.path, joinLines(spliceLines(fl, pos, b.old.length, n), br, final));
  });
}

// ---- SPEC.md section 8: V4A patches. ----

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** 1-based line of the section header, for the no-chunk parse error. */
  line: number;
  moveTo: string | null;
  chunks: V4AChunk[];
  addLines: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  let curChunk: { anchor: string | null; eof: boolean; bodyRaw: string[] } | null = null;
  const closeChunk = (strip: boolean): void => {
    if (curChunk === null) return;
    let body = curChunk.bodyRaw;
    if (strip) {
      while (body.length > 0 && blank(body[body.length - 1]!)) body = body.slice(0, -1);
    }
    const items: BodyItem[] = body.map((l) => {
      if (l === '' || blank(l)) return { kind: 'ctx', text: '' };
      if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
      if (l[0] === '-') return { kind: 'old', text: l.slice(1) };
      return { kind: 'new', text: l.slice(1) };
    });
    if (cur !== null && cur.kind === 'update') cur.chunks.push({ anchor: curChunk.anchor, eof: curChunk.eof, items });
    curChunk = null;
  };
  const closeSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'update') {
      closeChunk(true);
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
    }
    if (cur.kind === 'add') {
      const raw = [...cur.addLines];
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      cur.addLines = raw.map((l) => (l.startsWith('+') ? l.slice(1) : ''));
    }
    sections.push(cur);
    cur = null;
  };

  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      closeSection();
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: l.slice(prefix.length).trim(), line: i + 1, moveTo: null, chunks: [], addLines: [] };
      i += 1;
      continue;
    }
    if (cur === null) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (l.startsWith('+') || blank(l)) {
        cur.addLines.push(l);
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Update File section.
    if (l.startsWith('*** Move to: ')) {
      if (cur.chunks.length === 0 && curChunk === null && cur.moveTo === null) {
        cur.moveTo = l.slice('*** Move to: '.length).trim();
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (l.trim() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
      curChunk.eof = true;
      closeChunk(false);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk(false);
      const anchor = l.slice(2).trim();
      curChunk = { anchor: anchor === '' ? null : anchor, eof: false, bodyRaw: [] };
      i += 1;
      continue;
    }
    if (l === '' || blank(l) || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (curChunk === null) curChunk = { anchor: null, eof: false, bodyRaw: [] };
      curChunk.bodyRaw.push(blank(l) && l !== '' ? '' : l);
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();

  const chunkPair = (chunk: V4AChunk): LinesPair => {
    const o: string[] = [];
    const n: string[] = [];
    const nCtx: number[] = [];
    for (const it of chunk.items) {
      if (it.kind === 'ctx') {
        const oi = o.length;
        o.push(it.text);
        n.push(it.text);
        nCtx.push(oi);
      } else if (it.kind === 'old') o.push(it.text);
      else if (it.kind === 'new') {
        n.push(it.text);
        nCtx.push(-1);
      }
    }
    return { o, n, nCtx };
  };

  return sections.map((sec) => (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let { lines: fl, br, final } = fileLines(before);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const chunk of sec.chunks) {
      const pair = chunkPair(chunk);
      if (chunk.anchor !== null) {
        let foundIdx: number | null = null;
        for (const tier of tiers) {
          for (let k = cursor; k < fl.length; k += 1) {
            if (tierMatch(fl[k]!, chunk.anchor, tier)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx !== null) break;
        }
        if (foundIdx === null) throw new Fail('no-match', sec.path);
        cursor = foundIdx + 1;
      }
      if (pair.o.length === 0) {
        const insertAt = chunk.eof ? fl.length : cursor;
        const n = buildN(fl, pair, insertAt, 0);
        fl = spliceLines(fl, insertAt, 0, n);
        cursor = insertAt + n.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (const tier of tiers) {
          const positions = occurrences(fl, pair.o, tier).filter(
            (p) => p >= cursor && (!chunk.eof || p + pair.o.length === fl.length),
          );
          if (positions.length > 0) {
            found = { tier, pos: positions[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', sec.path);
        const n = buildN(fl, pair, found.pos, found.tier);
        fl = spliceLines(fl, found.pos, pair.o.length, n);
        cursor = found.pos + n.length;
      }
    }
    const out = joinLines(fl, br, final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : kind === 'v4a'
              ? v4aEdits(lines, strict)
              : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: Array<{ path: string; was: string | null; now: string | null }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.push({ path: p, was, now });
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    const o = changed.find((c) => c.path === oldP);
    const n = changed.find((c) => c.path === newP);
    if (o !== undefined && o.now === null && n !== undefined && n.was === null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const c of changed) {
    if (usedOld.has(c.path) || usedNew.has(c.path)) continue;
    rows.push({ key: c.path, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  if (!check) {
    for (const c of [...changed].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

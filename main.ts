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
  /** Successful moves, in patch order: [old path, new path]. */
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

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface Split {
  lines: string[];
  br: string;
  fin: boolean;
}
function splitText(text: string): Split {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, fin: false };
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}
function joinText(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** One line of N: a context line names its index in O; a new line names null. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** A line compared at one matching tier (SPEC.md section 5). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const at: number[] = [];
  const keys = old.map((l) => tierKey(l, tier));
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) at.push(i);
  }
  return at;
}
/** The first tier (0, then 1, then 2; only 0 when strict) at which `old` occurs at or after `from`. */
function findMatch(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(lines, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** Replace the matched lines at `pos` with N: a context line takes the file's own matched line, and at tier 2 every other line is re-indented (SPEC.md section 5). */
function spliceLines(lines: string[], pos: number, old: string[], next: NewLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  let lead = '';
  let pfx = '';
  if (tier === 2 && old.length > 0) {
    lead = /^[ \t]*/.exec(lines[pos]!)![0];
    pfx = /^[ \t]*/.exec(old[0]!)![0];
  }
  for (const item of next) {
    if (item.ctx !== null) out.push(lines[pos + item.ctx]!);
    else if (tier === 2 && old.length > 0 && item.text.trim() !== '' && item.text.startsWith(pfx)) out.push(lead + item.text.slice(pfx.length));
    else out.push(item.text);
  }
  out.push(...lines.slice(pos + old.length));
  return out;
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

/** One hunk of a unified diff (SPEC.md section 6). */
interface Hunk {
  /** The hunk's A: the 1-based start of its old lines. */
  a: number;
  old: string[];
  next: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface USection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
  sawPaths: boolean;
  sawHunk: boolean;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

/** A `--- ` or `+++ ` path: the text after the four characters, up to the first tab, trimmed, with a leading a/ or b/ removed; /dev/null means no file. */
function dashPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks to a file's text, in order (SPEC.md section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitText(text);
  let lines = f.lines;
  let fin = f.fin;
  let d = 0;
  for (const h of hunks) {
    if (h.old.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const ins = h.next.map((nl) => nl.text);
      const wasEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (wasEnd) fin = !h.noEol;
      d += h.next.length;
    } else {
      const m = findMatch(lines, h.old, strict, 0);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.at[0]!;
      for (const p of m.at) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + h.old.length === lines.length;
      lines = spliceLines(lines, best, h.old, h.next, m.tier);
      if (atEnd) fin = !h.noEol;
      d += h.next.length - h.old.length;
    }
  }
  return joinText(lines, f.br, fin);
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  const oldPath = firstDefined(s.dashOld, s.renameOld, s.diffOld);
  const newPath = firstDefined(s.dashNew, s.renameNew, s.diffNew);
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (p !== undefined && p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (oldPath === null || s.create) {
      // Creation: the new path does not exist; the file is the `+` lines of all hunks.
      if (newPath === null || newPath === undefined) throw new Fail('unsafe', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const content: string[] = [];
      for (const h of s.hunks) for (const nl of h.next) if (nl.ctx === null) content.push(nl.text);
      let noEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.next.some((nl) => nl.ctx === null)) {
          noEol = h.plusNoEol;
          break;
        }
      }
      tree.now.set(newPath, content.length === 0 ? '' : content.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (newPath === null || s.remove) {
      // Deletion: the old path exists; it is deleted, its hunks not read.
      if (oldPath === null || oldPath === undefined) throw new Fail('unsafe', '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    if (op !== np) {
      // Move: the hunks apply to the old file's lines, the result goes to the new path.
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(tree.get(op)!, s.hunks, strict, op);
      tree.now.set(np, result);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(tree.get(op)!, s.hunks, strict, op));
  };
}

/** Read a unified diff patch (SPEC.md section 6) into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const isPair = (at: number): boolean => lines[at]!.startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ ');
  let i = 0;
  let cur: USection | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: rest.slice(2, sep), diffNew: rest.slice(sep + 3).trimEnd(), dashOld: undefined, dashNew: undefined, renameOld: undefined, renameNew: undefined, create: false, remove: false, hunks: [], sawPaths: false, sawHunk: false };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && isPair(i)) {
      if (cur !== null && !cur.sawHunk && !cur.sawPaths) {
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
        cur.sawPaths = true;
        i += 2;
        continue;
      }
      cur = { diffOld: undefined, diffNew: undefined, dashOld: dashPath(line), dashNew: dashPath(lines[i + 1]!), renameOld: undefined, renameNew: undefined, create: false, remove: false, hunks: [], sawPaths: true, sawHunk: false };
      sections.push(cur);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !cur.sawHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.sawHunk = true;
      const body: Array<{ kind: 'ctx' | 'old' | 'new'; text: string; orig: string; backslash: boolean }> = [];
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && isPair(i)) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          if (b.startsWith('\\')) {
            if (body.length > 0) body[body.length - 1]!.backslash = true;
          } else if (b === '') {
            body.push({ kind: 'ctx', text: '', orig: b, backslash: false });
          } else if (b.startsWith(' ')) {
            body.push({ kind: 'ctx', text: b.slice(1), orig: b, backslash: false });
          } else if (b.startsWith('-')) {
            body.push({ kind: 'old', text: b.slice(1), orig: b, backslash: false });
          } else {
            body.push({ kind: 'new', text: b.slice(1), orig: b, backslash: false });
          }
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.orig === '') body.pop();
      const old: string[] = [];
      const next: NewLine[] = [];
      for (const e of body) {
        if (e.kind === 'ctx') {
          old.push(e.text);
          next.push({ text: e.text, ctx: old.length - 1 });
        } else if (e.kind === 'old') {
          old.push(e.text);
        } else {
          next.push({ text: e.text, ctx: null });
        }
      }
      let noEol = false;
      let plusNoEol = false;
      for (let k = body.length - 1; k >= 0; k--) {
        const e = body[k]!;
        if (e.kind === 'ctx' || e.kind === 'new') {
          noEol = e.backslash;
          break;
        }
      }
      for (let k = body.length - 1; k >= 0; k--) {
        const e = body[k]!;
        if (e.kind === 'new') {
          plusNoEol = e.backslash;
          break;
        }
      }
      cur.hunks.push({ a: Number(m[1]), old, next, noEol, plusNoEol });
      continue;
    }
    if (cur !== null && !cur.sawHunk) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SRBlock {
  path: string;
  old: string[];
  next: NewLine[];
}

/** Read a SEARCH/REPLACE patch (SPEC.md section 7) into one edit per block. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  const trail = (l: string): string => l.replace(/[ \t]+$/, '');
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | undefined = undefined;
  while (i < lines.length) {
    if (trail(lines[i]!) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    // The path is the nearest line before the SEARCH marker, after the previous block's REPLACE, that is not blank and does not start with ``` after trimming.
    let path: string | undefined = undefined;
    for (let k = i - 1; k > prevReplace; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchLine + 1}`);
    let j = searchLine + 1;
    while (j < lines.length && trail(lines[j]!) !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const old = lines.slice(searchLine + 1, j);
    j++;
    const newStart = j;
    while (j < lines.length && trail(lines[j]!) !== '>>>>>>> REPLACE') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const next: NewLine[] = lines.slice(newStart, j).map((t) => ({ text: t, ctx: null }));
    blocks.push({ path, old, next });
    prevPath = path;
    prevReplace = j;
    i = j + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : b.next.map((nl) => nl.text).join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitText(cur);
    const m = findMatch(f.lines, b.old, strict, 0);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.at.length !== 1) throw new Fail('ambiguous', b.path);
    tree.now.set(b.path, joinText(spliceLines(f.lines, m.at[0]!, b.old, b.next, m.tier), f.br, f.fin));
  });
}

/** One chunk of a V4A update section (SPEC.md section 8). */
interface VChunk {
  /** The anchor line, or null for no anchor. */
  anchor: string | null;
  old: string[];
  next: NewLine[];
  /** The chunk ends at the file's end. */
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Add lines, for an add section. */
  add: string[];
  /** The new path, for an update section with a move. */
  moveTo: string | undefined;
  chunks: VChunk[];
  /** The 1-based line of the section's header. */
  headerLine: number;
}

/** Apply one V4A update section to a file's lines, tracking the cursor (SPEC.md section 8). */
function applyV4AUpdate(text: string, s: VSection, strict: boolean, path: string): string {
  const f = splitText(text);
  let lines = f.lines;
  let cursor = 0;
  for (const c of s.chunks) {
    if (c.anchor !== null) {
      const m = findMatch(lines, [c.anchor], strict, cursor);
      if (m === null) throw new Fail('no-match', path);
      cursor = m.at[0]! + 1;
    }
    if (c.old.length === 0) {
      const at = c.eof ? lines.length : cursor;
      const ins = c.next.map((nl) => nl.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      cursor = at + ins.length;
      continue;
    }
    const m = findMatch(lines, c.old, strict, cursor);
    if (m === null) throw new Fail('no-match', path);
    let pos: number;
    if (c.eof) {
      pos = m.at.filter((p) => p + c.old.length === lines.length)[0] ?? -1;
      if (pos < 0) throw new Fail('no-match', path);
    } else {
      pos = m.at[0]!;
    }
    lines = spliceLines(lines, pos, c.old, c.next, m.tier);
    cursor = pos + c.next.length;
  }
  return joinText(lines, f.br, f.fin);
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    for (const p of [s.path, s.moveTo]) {
      if (p !== undefined && !safe(p)) throw new Fail('unsafe', p);
    }
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.add.length === 0 ? '' : s.add.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (tree.get(s.path) === null) throw new Fail('missing', s.path);
    const result = applyV4AUpdate(tree.get(s.path)!, s, strict, s.path);
    if (s.moveTo !== undefined) {
      if (s.moveTo !== s.path && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      tree.now.set(s.moveTo, result);
      if (s.moveTo !== s.path) {
        tree.now.set(s.path, null);
        tree.moves.push([s.path, s.moveTo]);
      }
      return;
    }
    tree.now.set(s.path, result);
  };
}

/** Read a V4A patch (SPEC.md section 8) into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const isHeader = (l: string): 'add' | 'delete' | 'update' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
  while (i < last) {
    const line = lines[i]!;
    const kind = isHeader(line);
    if (kind === null) {
      if (line.trim() === '') {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const s: VSection = { kind, path, add: [], moveTo: undefined, chunks: [], headerLine: i + 1 };
    sections.push(s);
    i++;
    // The section's lines run to the next header, the End Patch, or the last non-blank line, with trailing blank lines dropped.
    let end = i;
    while (end < last && isHeader(lines[end]!) === null) end++;
    let trimEnd = end;
    while (trimEnd > i && lines[trimEnd - 1]!.trim() === '') trimEnd--;
    const body = lines.slice(i, trimEnd);
    if (kind === 'add') {
      for (const [k, l] of body.entries()) {
        if (l.startsWith('+')) s.add.push(l.slice(1));
        else if (l === '') s.add.push('');
        else throw new Exit2(`error: parse ${i + k + 1}`);
      }
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        s.moveTo = body[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      let cur: VChunk | null = null;
      let canStart = true;
      const startChunk = (anchor: string | null): void => {
        cur = { anchor, old: [], next: [], eof: false };
        s.chunks.push(cur);
      };
      while (k < body.length) {
        const l = body[k]!;
        if (l.startsWith('@@')) {
          if (!canStart) throw new Exit2(`error: parse ${i + k + 1}`);
          const anchor = l.slice(2).trim();
          startChunk(anchor === '' ? null : anchor);
          k++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + k + 1}`);
          cur.eof = true;
          cur = null;
          canStart = false;
          k++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (!canStart || s.chunks.length > 0) throw new Exit2(`error: parse ${i + k + 1}`);
            startChunk(null);
          }
          if (l === '') {
            cur.old.push('');
            cur.next.push({ text: '', ctx: cur.old.length - 1 });
          } else if (l.startsWith(' ')) {
            cur.old.push(l.slice(1));
            cur.next.push({ text: l.slice(1), ctx: cur.old.length - 1 });
          } else if (l.startsWith('-')) {
            cur.old.push(l.slice(1));
          } else {
            cur.next.push({ text: l.slice(1), ctx: null });
          }
          k++;
          continue;
        }
        throw new Exit2(`error: parse ${i + k + 1}`);
      }
      if (s.chunks.length === 0 && s.moveTo === undefined) throw new Exit2(`error: parse ${s.headerLine}`);
    }
    i = end;
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move the patch recorded is shown as one R row, sorted by its new path, instead of its D and A rows.
  const rows: Array<[string, string]> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const moves = tree.moves
    .filter(([o, n]) => tree.get(o) === null && tree.get(n) !== null && tree.original(o) !== null && tree.original(n) === null)
    .sort((a, b) => Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])));
  for (const [o, n] of moves) {
    rows.push([n, `R ${o} -> ${n}`]);
    movedOld.add(o);
    movedNew.add(n);
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!movedOld.has(p) && !movedNew.has(p)) rows.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const linesOut = rows.map(([, r]) => r);
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
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

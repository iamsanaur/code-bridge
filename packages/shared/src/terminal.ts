/**
 * A small, dependency-free terminal output model for the mobile terminal view.
 *
 * Supported: printable text, \n, \r (carriage return overwrite), \b, \t, SGR
 * colours/bold (ESC[...m), erase-in-line (ESC[K), clear screen (ESC[2J / ESC[3J).
 * OSC sequences (window titles, hyperlinks) and other escapes are consumed and ignored.
 *
 * Not supported: cursor addressing beyond the current line, alternate screen,
 * scroll regions. Full-screen TUIs (vim, htop) will not render faithfully;
 * line-oriented tools (builds, tests, git, package managers) will.
 */

export interface TermStyle {
  /** ANSI colour index 0-15, or -1 for default. */
  fg: number;
  bold: boolean;
}

export interface TermSegment {
  text: string;
  style: TermStyle;
}

export type TermLine = TermSegment[];

const DEFAULT_STYLE = 0; // packed: bits 0-4 fg+1 (0 = default), bit 5 bold

function pack(fg: number, bold: boolean): number {
  return (fg + 1) | (bold ? 32 : 0);
}
function unpack(s: number): TermStyle {
  return { fg: (s & 31) - 1, bold: (s & 32) !== 0 };
}

interface Cell {
  ch: string;
  s: number;
}

export class TerminalBuffer {
  private lines: TermLine[] = [];
  private current: Cell[] = [];
  private col = 0;
  private style = DEFAULT_STYLE;
  private pending = '';
  private droppedLines = 0;
  private version = 0;

  constructor(private readonly maxLines = 5000) {}

  /** Number of lines discarded from the top to respect `maxLines`. */
  get dropped(): number {
    return this.droppedLines;
  }

  /** Increments on every write; handy as a React memo key. */
  get revision(): number {
    return this.version;
  }

  write(chunk: string): void {
    const data = this.pending + chunk;
    this.pending = '';
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === '\x1b') {
        const consumed = this.parseEscape(data, i);
        if (consumed === 0) {
          // Incomplete sequence: keep for the next chunk (bounded to avoid unbounded growth).
          this.pending = data.slice(i, i + 256);
          break;
        }
        i += consumed;
        continue;
      }
      switch (ch) {
        case '\n':
          this.commitLine();
          break;
        case '\r':
          this.col = 0;
          break;
        case '\b':
          this.col = Math.max(0, this.col - 1);
          break;
        case '\t': {
          const next = (Math.floor(this.col / 8) + 1) * 8;
          while (this.col < next) this.put(' ');
          break;
        }
        default:
          if (ch >= ' ' && ch !== '\x7f') this.put(ch);
      }
      i++;
    }
    this.version++;
  }

  clear(): void {
    this.lines = [];
    this.current = [];
    this.col = 0;
    this.version++;
  }

  /** All committed lines plus the in-progress line. */
  getLines(): TermLine[] {
    return [...this.lines, compress(this.current)];
  }

  /** Plain text of the whole buffer (used for copy). */
  toPlainText(): string {
    return this.getLines()
      .map((l) => l.map((s) => s.text).join(''))
      .join('\n');
  }

  private put(ch: string): void {
    const cell = { ch, s: this.style };
    if (this.col < this.current.length) this.current[this.col] = cell;
    else {
      while (this.current.length < this.col) this.current.push({ ch: ' ', s: DEFAULT_STYLE });
      this.current.push(cell);
    }
    this.col++;
  }

  private commitLine(): void {
    this.lines.push(compress(this.current));
    this.current = [];
    this.col = 0;
    if (this.lines.length > this.maxLines) {
      const excess = this.lines.length - this.maxLines;
      this.lines.splice(0, excess);
      this.droppedLines += excess;
    }
  }

  /** Returns number of chars consumed, or 0 if the sequence is incomplete. */
  private parseEscape(data: string, start: number): number {
    if (start + 1 >= data.length) return 0;
    const kind = data[start + 1];
    if (kind === '[') {
      // CSI: parameters 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e
      let j = start + 2;
      while (j < data.length) {
        const c = data.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) break;
        j++;
      }
      if (j >= data.length) return 0;
      this.applyCsi(data.slice(start + 2, j), data[j]!);
      return j - start + 1;
    }
    if (kind === ']') {
      // OSC: terminated by BEL or ST (ESC \)
      for (let j = start + 2; j < data.length; j++) {
        if (data[j] === '\x07') return j - start + 1;
        if (data[j] === '\x1b' && data[j + 1] === '\\') return j - start + 2;
      }
      return 0;
    }
    // Two-character escape (e.g. ESC =, ESC >, ESC 7) – ignore.
    return 2;
  }

  private applyCsi(params: string, final: string): void {
    if (final === 'm') {
      const codes = params === '' ? [0] : params.split(';').map((p) => (p === '' ? 0 : Number(p)));
      let { fg, bold } = unpack(this.style);
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k]!;
        if (c === 0) {
          fg = -1;
          bold = false;
        } else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if (c >= 30 && c <= 37) fg = c - 30;
        else if (c >= 90 && c <= 97) fg = c - 90 + 8;
        else if (c === 39) fg = -1;
        else if (c === 38 || c === 48) {
          // Extended colours: 38;5;n or 38;2;r;g;b – skip their arguments.
          k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 0;
        }
      }
      this.style = pack(fg, bold);
    } else if (final === 'K') {
      const mode = params === '' ? 0 : Number(params);
      if (mode === 0) this.current.length = Math.min(this.current.length, this.col);
      else if (mode === 2) {
        this.current = [];
      }
    } else if (final === 'J') {
      if (params === '2' || params === '3') this.clear();
    } else if (final === 'G') {
      this.col = Math.max(0, (Number(params) || 1) - 1);
    } else if (final === 'C') {
      this.col += Number(params) || 1;
    } else if (final === 'D') {
      this.col = Math.max(0, this.col - (Number(params) || 1));
    }
    // Everything else (cursor up/down, modes, etc.) is ignored.
  }
}

function compress(cells: Cell[]): TermLine {
  const out: TermLine = [];
  let text = '';
  let s = cells[0]?.s ?? DEFAULT_STYLE;
  for (const cell of cells) {
    if (cell.s !== s) {
      if (text) out.push({ text, style: unpack(s) });
      text = '';
      s = cell.s;
    }
    text += cell.ch;
  }
  if (text) out.push({ text, style: unpack(s) });
  return out;
}

/** Strip all escape sequences (used for notifications, previews and copy). */
export function stripAnsi(text: string): string {
  const t = new TerminalBuffer(Number.MAX_SAFE_INTEGER);
  t.write(text);
  return t.toPlainText();
}

// Minimal ELF32 little-endian symbol reader: enough to turn sampled PCs and
// crash backtraces into function names, and to check that the ELF on disk is
// the one the board is running (the app descriptor carries its SHA-256).

export interface Sym {
  addr: number;
  size: number;
  name: string;
}

export interface ElfSymbols {
  fileName: string;
  sha256: string;
  syms: Sym[]; // sorted by addr
  lookup(pc: number): Sym | null;
}

export async function loadElf(file: File): Promise<ElfSymbols> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const syms = parseSymbols(new Uint8Array(buf));
  return { fileName: file.name, sha256, syms, lookup: (pc) => lookup(syms, pc) };
}

export function parseSymbols(b: Uint8Array): Sym[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, false) !== 0x7f454c46) throw new Error('not an ELF file');
  if (b[4] !== 1 || b[5] !== 1) throw new Error('only 32-bit little-endian ELF is supported');
  const shoff = dv.getUint32(0x20, true);
  const shentsize = dv.getUint16(0x2e, true);
  const shnum = dv.getUint16(0x30, true);

  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({
      type: dv.getUint32(o + 4, true),
      offset: dv.getUint32(o + 16, true),
      size: dv.getUint32(o + 20, true),
      link: dv.getUint32(o + 24, true),
      entsize: dv.getUint32(o + 36, true),
    });
  }
  const symtab = sections.find((s) => s.type === 2); // SHT_SYMTAB
  if (!symtab) throw new Error('ELF has no symbol table');
  const strtab = sections[symtab.link];
  const td = new TextDecoder();
  const name = (off: number) => {
    let end = strtab.offset + off;
    while (end < b.length && b[end] !== 0) end++;
    return td.decode(b.subarray(strtab.offset + off, end));
  };

  const out: Sym[] = [];
  const n = symtab.size / (symtab.entsize || 16);
  for (let i = 0; i < n; i++) {
    const o = symtab.offset + i * 16;
    const info = b[o + 12];
    if ((info & 0xf) !== 2) continue; // STT_FUNC
    const addr = dv.getUint32(o + 4, true);
    if (!addr) continue;
    out.push({ addr, size: dv.getUint32(o + 8, true), name: name(dv.getUint32(o, true)) });
  }
  out.sort((a, c) => a.addr - c.addr);
  return out;
}

export function lookup(syms: Sym[], pc: number): Sym | null {
  let lo = 0;
  let hi = syms.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (syms[mid].addr <= pc) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  const s = syms[best];
  // Sized symbols must contain the pc; unsized ones get a 4 KB grace window.
  if (s.size ? pc < s.addr + s.size : pc - s.addr < 4096) return s;
  return null;
}

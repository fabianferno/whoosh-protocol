import { describe, expect, it } from 'vitest';
import { Assembler } from '../src/message/assembler.ts';
import { MAX_DICT_WORDS, packWords, unpackWords, WORDS } from '../src/message/dictionary.ts';
import { decodeText, MAX_TEXT_BYTES, MessageError, planMessage } from '../src/message/message.ts';
import { FrameType } from '../src/modem/frame.ts';

describe('dictionary', () => {
  it('has the 2048-word BIP39 list', () => {
    expect(WORDS).toHaveLength(2048);
    expect(WORDS[0]).toBe('abandon');
    expect(WORDS[2047]).toBe('zoo');
  });

  it('packs 4 words into 6 bytes and back', () => {
    const words = ['abandon', 'zoo', 'river', 'quick'];
    const packed = packWords(words)!;
    expect(packed).toHaveLength(6);
    expect(unpackWords(packed)).toEqual(words);
  });

  it('round-trips every word count from 1 to the maximum', () => {
    for (let n = 1; n <= MAX_DICT_WORDS; n++) {
      const words = Array.from({ length: n }, (_, i) => WORDS[(i * 91 + n * 7) % 2048]);
      expect(unpackWords(packWords(words)!)).toEqual(words);
    }
  });

  it('refuses unknown words, empty lists, and lists that are too long', () => {
    expect(packWords(['abandon', 'notaword'])).toBeNull();
    expect(packWords([])).toBeNull();
    expect(packWords(Array(MAX_DICT_WORDS + 1).fill('zoo'))).toBeNull();
  });
});

describe('planMessage', () => {
  it('uses one DICT frame when every word is in the list', () => {
    const plan = planMessage('river quick zoo abandon', 9);
    expect(plan.mode).toBe('dict');
    expect(plan.frames).toHaveLength(1);
    expect(plan.frames[0].type).toBe(FrameType.DICT);
    expect(decodeText(plan.frames[0].type, plan.frames[0].payload)).toBe('river quick zoo abandon');
  });

  it('falls back to text unless the words round-trip exactly', () => {
    for (const text of ['River quick zoo', 'river  quick', ' river quick', 'river quick ', 'hello there sings friend']) {
      expect(planMessage(text, 1).mode).toBe('text');
    }
  });

  it('splits long text into numbered chunks that reassemble to the original', () => {
    const text = 'x'.repeat(100);
    const plan = planMessage(text, 3);
    expect(plan.frames.map((f) => [f.index, f.total, f.length])).toEqual([[0, 4, 32], [1, 4, 32], [2, 4, 32], [3, 4, 4]]);
  });

  it('keeps multi-byte characters intact when a chunk boundary falls inside one', () => {
    const text = 'héllo wörld 😀😀😀😀😀😀😀😀😀😀 ünïcode ✓✓✓✓✓✓✓✓✓✓✓✓';
    const plan = planMessage(text, 5);
    expect(plan.frames.length).toBeGreaterThan(1);
    const asm = new Assembler();
    let result = '';
    for (const f of plan.frames) {
      const { completed } = asm.add(f);
      if (completed) result = decodeText(completed.type, completed.bytes);
    }
    expect(result).toBe(text);
  });

  it('rejects empty and whitespace-only messages', () => {
    for (const text of ['', '   ', '\n']) {
      expect(() => planMessage(text, 1)).toThrow(MessageError);
    }
  });

  it('accepts exactly the size limit and rejects one byte more', () => {
    expect(planMessage('a'.repeat(MAX_TEXT_BYTES), 1).frames).toHaveLength(16);
    expect(() => planMessage('a'.repeat(MAX_TEXT_BYTES + 1), 1)).toThrow(/limit/);
  });
});

describe('Assembler', () => {
  const frames = planMessage('a'.repeat(70), 11).frames;

  it('completes a message from chunks in any order and reports progress', () => {
    const asm = new Assembler();
    expect(asm.add(frames[2]).progress).toEqual({ msgId: 11, received: 1, total: 3 });
    expect(asm.add(frames[0]).progress.received).toBe(2);
    const last = asm.add(frames[1]);
    expect(last.completed && decodeText(last.completed.type, last.completed.bytes)).toBe('a'.repeat(70));
  });

  it('ignores duplicate chunks', () => {
    const asm = new Assembler();
    asm.add(frames[0]);
    expect(asm.add(frames[0]).progress.received).toBe(1);
  });

  it('does not deliver a looped message a second time', () => {
    const asm = new Assembler();
    const delivered = [...frames, ...frames, ...frames].filter((f) => asm.add(f).completed);
    expect(delivered).toHaveLength(1);
  });

  it('delivers a new message that reuses the id of a finished one', () => {
    const asm = new Assembler();
    frames.forEach((f) => asm.add(f));
    const other = planMessage('b'.repeat(70), 11).frames;
    const results = other.map((f) => asm.add(f).completed).filter(Boolean);
    expect(results).toHaveLength(1);
  });

  it('keeps interleaved messages apart', () => {
    const asm = new Assembler();
    const a = planMessage('a'.repeat(40), 1).frames;
    const b = planMessage('b'.repeat(40), 2).frames;
    const out: string[] = [];
    for (const f of [a[0], b[0], b[1], a[1]]) {
      const { completed } = asm.add(f);
      if (completed) out.push(decodeText(completed.type, completed.bytes)[0]);
    }
    expect(out).toEqual(['b', 'a']);
  });

  it('restarts a message when a chunk contradicts the earlier ones', () => {
    const asm = new Assembler();
    asm.add(planMessage('a'.repeat(40), 4).frames[0]);
    const result = planMessage('c'.repeat(40), 4).frames.map((f) => asm.add(f).completed).filter(Boolean);
    expect(result).toHaveLength(1);
    expect(decodeText(result[0]!.type, result[0]!.bytes)).toBe('c'.repeat(40));
  });
});

// Minimal RouterOS API client implemented directly against the documented
// binary protocol (https://wiki.mikrotik.com/wiki/Manual:API), using Deno's
// native TCP socket API. This replaces the Node "node-routeros" library,
// which cannot run in the Supabase Edge Function (Deno) runtime.
//
// Login compatibility: the client tries the modern plain-text flow first
// (RouterOS >= 6.43). If that router rejects the modern login attributes as
// unknown parameters, it retries the documented legacy MD5 challenge flow.
// Script creation never sends permission or policy parameters; RouterOS uses
// the permissions attached to the configured API/Winbox account.

export interface RouterOSConnection {
  write(words: string[]): Promise<void>;
  readSentence(): Promise<{ reply: string; attrs: Record<string, string> }>;
  /** Sends a command and collects all "!re" rows until "!done". */
  command(words: string[]): Promise<Record<string, string>[]>;
  close(): void;
}

function encodeLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x4000) return new Uint8Array([0x80 | (len >> 8), len & 0xff]);
  if (len < 0x200000) {
    return new Uint8Array([0xc0 | (len >> 16), (len >> 8) & 0xff, len & 0xff]);
  }
  if (len < 0x10000000) {
    return new Uint8Array([
      0xe0 | (len >> 24),
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }
  return new Uint8Array([
    0xf0,
    (len >>> 24) & 0xff,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
  ]);
}

class ByteReader {
  private buffer = new Uint8Array(0);

  constructor(private conn: Deno.Conn) {}

  private async fill(min: number): Promise<void> {
    while (this.buffer.length < min) {
      const chunk = new Uint8Array(4096);
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("MikroTik connection closed unexpectedly");
      const merged = new Uint8Array(this.buffer.length + n);
      merged.set(this.buffer, 0);
      merged.set(chunk.subarray(0, n), this.buffer.length);
      this.buffer = merged;
    }
  }

  async readByte(): Promise<number> {
    await this.fill(1);
    const b = this.buffer[0];
    this.buffer = this.buffer.subarray(1);
    return b;
  }

  async readBytes(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);
    await this.fill(n);
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async readWordLength(): Promise<number> {
    const b0 = await this.readByte();
    if ((b0 & 0x80) === 0) return b0;
    if ((b0 & 0xc0) === 0x80) {
      const b1 = await this.readByte();
      return ((b0 & 0x3f) << 8) | b1;
    }
    if ((b0 & 0xe0) === 0xc0) {
      const b1 = await this.readByte();
      const b2 = await this.readByte();
      return ((b0 & 0x1f) << 16) | (b1 << 8) | b2;
    }
    if ((b0 & 0xf0) === 0xe0) {
      const b1 = await this.readByte();
      const b2 = await this.readByte();
      const b3 = await this.readByte();
      return ((b0 & 0x0f) << 24) | (b1 << 16) | (b2 << 8) | b3;
    }
    const b1 = await this.readByte();
    const b2 = await this.readByte();
    const b3 = await this.readByte();
    const b4 = await this.readByte();
    return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
  }

  async readWord(): Promise<string | null> {
    const len = await this.readWordLength();
    if (len === 0) return null; // end of sentence
    const bytes = await this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }
}

function rotateLeft(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

/** Minimal MD5 implementation for the legacy RouterOS challenge-response
 * login. It operates on raw bytes so the challenge is not altered by UTF-8
 * encoding. Modern RouterOS uses the plain-text login path first. */
function md5Hex(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = (input.length + 9 + 63) & ~63;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + constants[i] + words[g]) >>> 0, shifts[i])) >>> 0;
      a = previousD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const littleEndianHex = (value: number) =>
    Array.from({ length: 4 }, (_, i) => ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("");
  return `${littleEndianHex(a0)}${littleEndianHex(b0)}${littleEndianHex(c0)}${littleEndianHex(d0)}`;
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error("RouterOS returned an invalid legacy login challenge");
  }
  return Uint8Array.from(value.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
}

export async function connectRouterOS(params: {
  host: string;
  port: number;
  username: string;
  password: string;
  ssl: boolean;
  timeoutMs?: number;
}): Promise<RouterOSConnection> {
  const conn = params.ssl
    ? await Deno.connectTls({ hostname: params.host, port: params.port })
    : await Deno.connect({ hostname: params.host, port: params.port });

  const reader = new ByteReader(conn);

  async function write(words: string[]): Promise<void> {
    const parts: Uint8Array[] = [];
    for (const word of words) {
      const wordBytes = new TextEncoder().encode(word);
      parts.push(encodeLength(wordBytes.length), wordBytes);
    }
    parts.push(new Uint8Array([0])); // end of sentence
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    await conn.write(out);
  }

  async function readSentence(): Promise<{ reply: string; attrs: Record<string, string> }> {
    const words: string[] = [];
    while (true) {
      const word = await reader.readWord();
      if (word === null) break;
      words.push(word);
    }
    const reply = words[0] ?? "";
    const attrs: Record<string, string> = {};
    for (const w of words.slice(1)) {
      const eq = w.indexOf("=", 1);
      if (w.startsWith("=") && eq > 0) {
        attrs[w.slice(1, eq)] = w.slice(eq + 1);
      }
    }
    return { reply, attrs };
  }

  async function command(words: string[]): Promise<Record<string, string>[]> {
    await write(words);
    const rows: Record<string, string>[] = [];
    while (true) {
      const { reply, attrs } = await readSentence();
      if (reply === "!re") {
        rows.push(attrs);
      } else if (reply === "!done") {
        return rows;
      } else if (reply === "!trap" || reply === "!fatal") {
        const detail = attrs.message ?? `MikroTik API error (${reply})`;
        throw new Error(`RouterOS command ${words[0]} failed: ${detail}`);
      }
    }
  }

  async function completeLegacyLogin(ret: string): Promise<void> {
    const passwordBytes = new TextEncoder().encode(`\u0000${params.password}`);
    const challengeBytes = hexToBytes(ret);
    const digestInput = new Uint8Array(passwordBytes.length + challengeBytes.length);
    digestInput.set(passwordBytes);
    digestInput.set(challengeBytes, passwordBytes.length);
    const response = `00${md5Hex(digestInput)}`;

    await write(["/login", `=name=${params.username}`, `=response=${response}`]);
    const legacy = await readSentence();
    if (legacy.reply === "!trap" || legacy.reply === "!fatal") {
      throw new Error(legacy.attrs.message ?? "MikroTik legacy login failed");
    }
    if (legacy.reply !== "!done") {
      throw new Error(`Unexpected legacy login response: ${legacy.reply}`);
    }
  }

  async function requestLegacyChallenge(): Promise<void> {
    await write(["/login"]);
    const challenge = await readSentence();
    if (challenge.reply === "!trap" || challenge.reply === "!fatal") {
      throw new Error(challenge.attrs.message ?? "MikroTik legacy login failed");
    }
    const ret = challenge.attrs.ret;
    if (challenge.reply !== "!done" || !ret) {
      throw new Error("RouterOS did not return a legacy login challenge");
    }
    await completeLegacyLogin(ret);
  }

  async function login(): Promise<void> {
    // RouterOS 6.43+ accepts a username and password in the first /login
    // request. No script policy or permission parameter is ever sent.
    await write(["/login", `=name=${params.username}`, `=password=${params.password}`]);
    const modern = await readSentence();

    // Some compatible firmware returns a legacy challenge even after the
    // modern request. A !done with ret is not authenticated yet; complete the
    // documented challenge-response exchange instead of treating it as done.
    if (modern.reply === "!done") {
      if (modern.attrs.ret) await completeLegacyLogin(modern.attrs.ret);
      return;
    }

    const modernError = modern.attrs.message ?? "MikroTik login failed";
    // Older firmware rejects modern attributes. Only then make a separate
    // bare /login request to obtain the legacy challenge.
    if ((modern.reply === "!trap" || modern.reply === "!fatal") && /unknown parameter/i.test(modernError)) {
      await requestLegacyChallenge();
      return;
    }
    throw new Error(modernError);
  }

  await login();

  return {
    write,
    readSentence,
    command,
    close: () => {
      try {
        conn.close();
      } catch {
        /* already closed */
      }
    },
  };
}

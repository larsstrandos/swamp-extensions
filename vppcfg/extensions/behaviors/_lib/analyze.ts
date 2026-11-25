/**
 * Pure helpers: vppcfg output, risky plan lines, a line diff for the YAML,
 * and a before/after comparison of `birdc show protocols`.
 *
 * @module
 */

/** CLI commands in vppcfg output, without `comment { ... }` lines and blanks. */
export function vppcfgCommands(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter((
    l,
  ) => l !== "" && !l.startsWith("comment {"));
}

/** Patterns for plan lines that remove something or interrupt traffic. */
const RISKY: [RegExp, string][] = [
  [/^lcp delete /, "removes a Linux interface (routing daemons lose it)"],
  [/^delete /, "deletes an interface"],
  [/^set interface ip address del /, "removes an address"],
  [/^set interface state \S+ down$/, "takes an interface down"],
  [/^set interface unnumbered \S+ del/, "removes unnumbered"],
  [/^set interface ip6? table /, "moves an interface to another table"],
  [/ del( |$)/, "deletes configuration"],
];

/** One plan line that needs explicit consent. */
export interface RiskyCommand {
  /** The vppcfg CLI line. */
  command: string;
  /** Why it is risky. */
  reason: string;
}

/** Plan lines that remove something or interrupt traffic. */
export function riskyCommands(commands: string[]): RiskyCommand[] {
  const out: RiskyCommand[] = [];
  for (const command of commands) {
    const hit = RISKY.find(([re]) => re.test(command));
    if (hit) out.push({ command, reason: hit[1] });
  }
  return out;
}

/** Unified-style line diff (`+`/`-`/` ` prefixes, changed regions only with context). */
export function lineDiff(before: string, after: string, context = 2): string[] {
  const a = before.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const b = after.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  // LCS table; vppcfg YAML files are small (hundreds of lines).
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from(
    { length: n + 1 },
    () => Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(" " + a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push("-" + a[i++]);
    else ops.push("+" + b[j++]);
  }
  while (i < n) ops.push("-" + a[i++]);
  while (j < m) ops.push("+" + b[j++]);
  // keep changed lines plus context
  const keep = new Set<number>();
  ops.forEach((o, k) => {
    if (o[0] !== " ") {
      for (let c = k - context; c <= k + context; c++) {
        if (c >= 0 && c < ops.length) keep.add(c);
      }
    }
  });
  const out: string[] = [];
  let last = -1;
  for (const k of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && k > last + 1) out.push("...");
    out.push(ops[k]);
    last = k;
  }
  return out;
}

/** One row of `birdc show protocols`. */
export interface BirdProtocol {
  /** Protocol name. */
  name: string;
  /** Protocol type, e.g. BGP. */
  proto: string;
  /** `up`, `down`, `start`, ... */
  state: string;
  /** Info column, e.g. `Established`, `Active  Socket: ...`. */
  info: string;
}

const SINCE =
  /^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}(:\d{2})?(\.\d+)?|\d{2}\.\d{2}\.\d{4})$/;

/** Parse `birdc show protocols` (BIRD 2 and 3). */
export function parseBirdProtocols(text: string): BirdProtocol[] {
  const out: BirdProtocol[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^(BIRD |Name\s+Proto)/.test(line) || !line.trim()) continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    const [name, proto, , state] = t;
    let k = 4;
    while (k < t.length && SINCE.test(t[k])) k++;
    out.push({ name, proto, state, info: t.slice(k).join(" ") });
  }
  return out;
}

/** A protocol whose state changed between two snapshots. */
export interface BirdChange {
  /** Protocol name. */
  name: string;
  /** Protocol type. */
  proto: string;
  /** `state info` before (absent: protocol is new). */
  before?: string;
  /** `state info` after (absent: protocol is gone). */
  after?: string;
  /** It was up/Established/Running before and is not now. */
  lost: boolean;
}

function healthy(p: BirdProtocol): boolean {
  return p.state === "up";
}

/** Compare two snapshots on state and the first word of info. */
export function compareBird(
  before: BirdProtocol[],
  after: BirdProtocol[],
): BirdChange[] {
  const key = (p: BirdProtocol) =>
    `${p.state} ${p.info.split(" ")[0] ?? ""}`.trim();
  const a = new Map(after.map((p) => [p.name, p]));
  const changes: BirdChange[] = [];
  for (const p of before) {
    const q = a.get(p.name);
    if (!q) {
      changes.push({
        name: p.name,
        proto: p.proto,
        before: key(p),
        lost: healthy(p),
      });
    } else if (key(p) !== key(q)) {
      changes.push({
        name: p.name,
        proto: p.proto,
        before: key(p),
        after: key(q),
        lost: healthy(p) && !healthy(q),
      });
    }
    a.delete(p.name);
  }
  for (const q of a.values()) {
    changes.push({ name: q.name, proto: q.proto, after: key(q), lost: false });
  }
  return changes;
}

/** Hex SHA-256 of a string. */
export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

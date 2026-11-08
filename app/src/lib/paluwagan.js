import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

// ---------- Config ----------

export const PROGRAM_ID = new PublicKey(
  import.meta.env?.VITE_PROGRAM_ID || globalThis.process?.env?.VITE_PROGRAM_ID || "11111111111111111111111111111111"
);

// Demo conversion rate so people can think in pesos. Not a real price feed.
export const PHP_PER_SOL = Number(import.meta.env?.VITE_PHP_PER_SOL || globalThis.process?.env?.VITE_PHP_PER_SOL || 10000);
export const LAMPORTS_PER_SOL = 1_000_000_000;

export const STATE = { OPEN: 0, ACTIVE: 1, COMPLETED: 2 };

export const phpToLamports = (php) =>
  Math.round((Number(php) / PHP_PER_SOL) * LAMPORTS_PER_SOL);
export const lamportsToPhp = (lamports) =>
  (Number(lamports) / LAMPORTS_PER_SOL) * PHP_PER_SOL;
export const lamportsToSol = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;

// ---------- Anchor discriminators ----------
// Anchor identifies each instruction and account type by the first 8 bytes of
// sha256("global:<instruction_name>") or sha256("account:<AccountName>").

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

const discCache = {};
async function disc(prefix, name) {
  const key = `${prefix}:${name}`;
  if (!discCache[key]) discCache[key] = (await sha256(key)).slice(0, 8);
  return discCache[key];
}

// ---------- Borsh encoding helpers ----------

function u8(n) {
  return Uint8Array.of(n);
}
function u64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}
function str(s) {
  const bytes = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length, true);
  return concat(len, bytes);
}
function concat(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------- PDA ----------

export function findGroupPda(creator, name) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("group"), creator.toBuffer(), Buffer.from(name)],
    PROGRAM_ID
  )[0];
}

// ---------- Account decoding ----------

export function decodeGroup(pubkey, data, lamports) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8; // skip discriminator

  const readPubkey = () => {
    const pk = new PublicKey(data.slice(o, o + 32));
    o += 32;
    return pk;
  };
  const readU8 = () => data[o++];
  const readU16 = () => {
    const v = view.getUint16(o, true);
    o += 2;
    return v;
  };
  const readU32 = () => {
    const v = view.getUint32(o, true);
    o += 4;
    return v;
  };
  const readU64 = () => {
    const v = view.getBigUint64(o, true);
    o += 8;
    return v;
  };
  const readString = () => {
    const len = readU32();
    const s = new TextDecoder().decode(data.slice(o, o + len));
    o += len;
    return s;
  };
  const readBytes = () => {
    const len = readU32();
    const arr = Array.from(data.slice(o, o + len));
    o += len;
    return arr;
  };

  const creator = readPubkey();
  const name = readString();
  const contribution = readU64();
  const maxMembers = readU8();
  const memberCount = readU32();
  const members = [];
  for (let i = 0; i < memberCount; i++) members.push(readPubkey());
  const payoutOrder = readBytes();
  const contributions = readBytes();
  const currentRound = readU8();
  const paidMask = readU16();
  const state = readU8();

  return {
    address: pubkey,
    creator,
    name,
    contribution,
    maxMembers,
    members,
    payoutOrder,
    contributions,
    currentRound,
    paidMask,
    state,
    lamports,
    hasPaid: (idx) => (paidMask & (1 << idx)) !== 0,
    allPaid: members.length > 0 && paidMask === (1 << members.length) - 1,
    currentWinner:
      state === 1 && payoutOrder.length
        ? members[payoutOrder[currentRound]]
        : null,
  };
}

export async function fetchGroups(connection) {
  const groupDisc = await disc("account", "Group");
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Encode(groupDisc) } }],
  });
  return accounts
    .map(({ pubkey, account }) =>
      decodeGroup(pubkey, new Uint8Array(account.data), account.lamports)
    )
    .sort((a, b) => a.state - b.state || a.name.localeCompare(b.name));
}

// Tiny base58 encoder for the memcmp filter (avoids an extra dependency)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

// ---------- Instructions ----------

async function ix(name, keys, args = new Uint8Array()) {
  const data = concat(await disc("global", name), args);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  });
}

export async function createGroupTx(creator, name, contributionLamports, maxMembers) {
  const group = findGroupPda(creator, name);
  const instruction = await ix(
    "create_group",
    [
      { pubkey: group, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    concat(str(name), u64(contributionLamports), u8(maxMembers))
  );
  return { tx: new Transaction().add(instruction), group };
}

export async function joinGroupTx(group, member) {
  return new Transaction().add(
    await ix("join_group", [
      { pubkey: group, isSigner: false, isWritable: true },
      { pubkey: member, isSigner: true, isWritable: false },
    ])
  );
}

export async function startAndDrawTx(group, creator) {
  return new Transaction().add(
    await ix("start_and_draw", [
      { pubkey: group, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: false },
    ])
  );
}

export async function contributeTx(group, member) {
  return new Transaction().add(
    await ix("contribute", [
      { pubkey: group, isSigner: false, isWritable: true },
      { pubkey: member, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ])
  );
}

export async function payoutTx(group, winner, caller) {
  return new Transaction().add(
    await ix("payout", [
      { pubkey: group, isSigner: false, isWritable: true },
      { pubkey: winner, isSigner: false, isWritable: true },
      { pubkey: caller, isSigner: true, isWritable: false },
    ])
  );
}

// ---------- Suki badges (gamification) ----------

export function badgeFor(contributionCount, roundsSoFar) {
  if (roundsSoFar > 0 && contributionCount >= roundsSoFar && contributionCount >= 3)
    return { label: "Gold suki", tier: "gold" };
  if (contributionCount >= 2) return { label: "Silver suki", tier: "silver" };
  if (contributionCount >= 1) return { label: "Bronze suki", tier: "bronze" };
  return { label: "New member", tier: "new" };
}

export const shortKey = (pk) => {
  const s = pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

// Turn Anchor error codes into readable messages
const ERRORS = {
  6000: "Group name must be 1 to 32 characters.",
  6001: "Contribution must be at least 0.001 SOL.",
  6002: "Members must be between 2 and 10.",
  6003: "This group is no longer accepting members.",
  6004: "You are already a member.",
  6005: "This group is full.",
  6006: "At least 2 members are needed to start.",
  6007: "This group has not started or is already finished.",
  6008: "You are not a member of this group.",
  6009: "You already contributed this round.",
  6010: "Not everyone has contributed this round yet.",
  6011: "That wallet is not this round's winner.",
  6012: "Math overflow.",
};

export function friendlyError(err) {
  const text = String(err?.message || err);
  const match = text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (match) {
    const code = parseInt(match[1], 16);
    if (ERRORS[code]) return ERRORS[code];
  }
  if (/already in use/i.test(text)) return "You already have a group with that name.";
  if (/insufficient/i.test(text)) return "Not enough devnet SOL. Get more from faucet.solana.com.";
  if (/User rejected/i.test(text)) return "You cancelled the transaction.";
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  STATE,
  PHP_PER_SOL,
  badgeFor,
  contributeTx,
  createGroupTx,
  fetchGroups,
  friendlyError,
  joinGroupTx,
  lamportsToPhp,
  lamportsToSol,
  payoutTx,
  phpToLamports,
  shortKey,
  startAndDrawTx,
} from "./lib/paluwagan";

// Read an API response safely. If the server crashed and returned plain text
// (e.g. Vercel's "A server error has occurred"), show that text instead of a JSON parse error.
async function readJson(res) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server error (${res.status}): ${text.slice(0, 200) || res.statusText}`);
  }
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}

const peso = (n) =>
  "₱" + Number(n).toLocaleString("en-PH", { maximumFractionDigits: 2 });

// ---------- Small UI pieces ----------
const Icon = {
  sparkle: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 13z" />
    </svg>
  ),
  bot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />
    </svg>
  ),
  external: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width="14" height="14">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  ),
};

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f5bff" /><stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="logo-p" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd166" /><stop offset="1" stopColor="#f5a524" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="10" fill="url(#logo-g)" />
      {Array.from({ length: 6 }).map((_, i) => {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        return <circle key={i} cx={16 + 9.5 * Math.cos(a)} cy={16 + 9.5 * Math.sin(a)} r="2.2" fill="#fff" opacity="0.92" />;
      })}
      <circle cx="16" cy="16" r="4.6" fill="url(#logo-p)" />
    </svg>
  );
}

// A colorful avatar derived from the wallet address, so members are easy to tell apart.
function Avatar({ pk }) {
  const s = pk.toBase58();
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: `linear-gradient(135deg, hsl(${h} 75% 62%), hsl(${(h + 50) % 360} 70% 48%))` }}
    />
  );
}

const Spinner = () => <span className="spinner" aria-hidden="true" />;

export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setGroups(await fetchGroups(connection));
    } catch (e) {
      setToast({ kind: "error", text: "Could not load groups. Check VITE_PROGRAM_ID in your .env file." });
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  // Sign, send, confirm, then refresh. Every action uses this.
  const send = async (label, buildTx, successText) => {
    if (!wallet.publicKey) {
      setToast({ kind: "error", text: "Connect your wallet first." });
      return false;
    }
    setBusy(label);
    setToast(null);
    try {
      const tx = await buildTx();
      const sig = await wallet.sendTransaction(tx, connection);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      setToast({ kind: "ok", text: successText, sig });
      await refresh();
      return true;
    } catch (e) {
      setToast({ kind: "error", text: friendlyError(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const activeGroups = groups.filter((g) => g.state === STATE.ACTIVE);
  const memberCount = groups.reduce((sum, g) => sum + g.members.length, 0);
  const inPots = activeGroups.reduce((sum, g) => sum + lamportsToPhp(g.contribution) * countPaid(g), 0);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Paluwagan</span>
          <span className="net">Devnet</span>
        </div>
        <WalletMultiButton />
      </header>

      <section className="hero">
        <span className="eyebrow"><b>New</b> On-chain savings circles with an AI agent</span>
        <h1>
          Ipon nang <span className="grad-text">walang takbuhan.</span>
        </h1>
        <p>
          A paluwagan where the pot is held by a Solana program, not a person.
          Everyone sees who has paid, the payout order is drawn on-chain, and
          the pot goes straight to the right member. Nobody can run away with it.
        </p>
        <div className="stats">
          <div className="stat"><strong>{loading ? "–" : groups.length}</strong><span>Groups on-chain</span></div>
          <div className="stat"><strong>{loading ? "–" : activeGroups.length}</strong><span>Active rounds</span></div>
          <div className="stat"><strong>{loading ? "–" : memberCount}</strong><span>Members</span></div>
          <div className="stat"><strong>{loading ? "–" : peso(inPots)}</strong><span>In pots right now</span></div>
        </div>
      </section>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span>{toast.text}</span>
          {toast.sig && (
            <a
              className="link"
              href={`https://explorer.solana.com/tx/${toast.sig}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              Explorer {Icon.external}
            </a>
          )}
          <button className="link" onClick={() => setToast(null)}>Dismiss</button>
        </div>
      )}

      <main className="layout">
        <aside className="side">
          <CreateGroup send={send} busy={busy} wallet={wallet} />
          <AgentPanel onDone={refresh} />
        </aside>

        <section className="groups">
          <div className="groups-head">
            <h2>Groups {!loading && <span className="count">{groups.length}</span>}</h2>
            <button className="ghost" onClick={refresh}>{Icon.refresh} Refresh</button>
          </div>
          {loading && (
            <div aria-label="Loading groups from Solana" role="status">
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          )}
          {!loading && groups.length === 0 && (
            <div className="empty">
              <strong>No groups yet</strong>
              Start the first one with the form on the left.
            </div>
          )}
          {groups.map((g) => (
            <GroupCard
              key={g.address.toBase58()}
              group={g}
              me={wallet.publicKey}
              send={send}
              busy={busy}
            />
          ))}
        </section>
      </main>

      <footer className="foot">
        Demo rate: 1 SOL = {peso(PHP_PER_SOL)}. Runs on Solana devnet with test SOL.
      </footer>
    </div>
  );
}

function CreateGroup({ send, busy, wallet }) {
  const [text, setText] = useState("");
  const [coachNote, setCoachNote] = useState(null);
  const [coachBusy, setCoachBusy] = useState(false);
  const [form, setForm] = useState({ name: "", php: 500, members: 5 });

  const askCoach = async () => {
    setCoachBusy(true);
    setCoachNote(null);
    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "setup", text }),
      });
      const data = await readJson(res);
      setForm({ name: data.name, php: data.contributionPhp, members: data.members });
      setCoachNote({
        kind: "ok",
        text: [data.explanation, data.schedule && `Schedule: ${data.schedule}.`].filter(Boolean).join(" "),
      });
    } catch (e) {
      setCoachNote({ kind: "error", text: `Coach is unavailable: ${e.message}. You can fill in the form below.` });
    } finally {
      setCoachBusy(false);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    const ok = await send(
      "create",
      async () =>
        (await createGroupTx(wallet.publicKey, name, phpToLamports(form.php), Number(form.members))).tx,
      `Created "${name}". Share it so members can join.`
    );
    if (ok) {
      setForm({ name: "", php: 500, members: 5 });
      setText("");
      setCoachNote(null);
    }
  };

  const pot = Number(form.php || 0) * Number(form.members || 0);

  return (
    <div className="panel">
      <h2><span className="icon-chip">{Icon.plus}</span>Start a paluwagan</h2>
      <p className="muted small">Describe it in your own words, or fill in the form.</p>

      <label className="field">
        <span>Describe your group, and the coach fills in the form</span>
        <textarea
          rows={3}
          maxLength={500}
          placeholder="Hal. 6 kami sa barkada, ₱300 kada Biyernes, tawagin nating Ipon Squad"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button className="secondary block" onClick={askCoach} disabled={!text.trim() || coachBusy}>
        {coachBusy ? <><Spinner /> Asking the coach…</> : <>{Icon.sparkle} Ask the AI coach</>}
      </button>
      {coachNote && <p className={`note ${coachNote.kind}`}>{coachNote.text}</p>}

      <form onSubmit={create} className="form">
        <label className="field">
          <span>Group name</span>
          <input
            required
            maxLength={32}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Ipon Squad"
          />
        </label>
        <div className="row">
          <label className="field">
            <span>Each member pays (₱)</span>
            <input
              type="number"
              min={10}
              required
              value={form.php}
              onChange={(e) => setForm({ ...form, php: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Members</span>
            <input
              type="number"
              min={2}
              max={10}
              required
              value={form.members}
              onChange={(e) => setForm({ ...form, members: e.target.value })}
            />
          </label>
        </div>
        <div className="pot-preview">
          <div>
            Pot each round
            <strong>{peso(pot)}</strong>
          </div>
          <span>{lamportsToSol(phpToLamports(pot)).toFixed(3)} SOL · everyone gets it once</span>
        </div>
        <button className="primary" disabled={!wallet.publicKey || busy === "create"}>
          {busy === "create" ? <><Spinner /> Creating…</> : wallet.publicKey ? "Create group" : "Connect wallet to create"}
        </button>
      </form>
    </div>
  );
}

function GroupCard({ group: g, me, send, busy }) {
  const [coach, setCoach] = useState(null);
  const [coachBusy, setCoachBusy] = useState(false);

  const myIdx = me ? g.members.findIndex((m) => m.equals(me)) : -1;
  const isMember = myIdx >= 0;
  const isCreator = me && g.creator.equals(me);
  const id = g.address.toBase58();
  const n = g.members.length;
  const potPhp = lamportsToPhp(g.contribution) * n;
  const roundsDone = g.currentRound;

  const statusText =
    g.state === STATE.OPEN
      ? `Open for members: ${n} of ${g.maxMembers} joined`
      : g.state === STATE.ACTIVE
      ? `Round ${g.currentRound + 1} of ${n}: ${countPaid(g)} of ${n} paid`
      : "Completed. Everyone received their pot.";

  const askCoach = async () => {
    setCoachBusy(true);
    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "status",
          group: {
            name: g.name,
            status: statusText,
            contributionPhp: lamportsToPhp(g.contribution),
            potPhp,
            unpaidMembers: g.members.filter((_, i) => !g.hasPaid(i)).map(shortKey),
          },
        }),
      });
      const data = await readJson(res);
      setCoach(data);
    } catch (e) {
      setCoach({ summary: `Coach is unavailable: ${e.message}`, advice: "", risk: "medium" });
    } finally {
      setCoachBusy(false);
    }
  };

  const paidCount = countPaid(g);
  const progress =
    g.state === STATE.OPEN ? n / g.maxMembers : g.state === STATE.ACTIVE ? paidCount / n : 1;
  const pill =
    g.state === STATE.OPEN ? ["open", "Open"] : g.state === STATE.ACTIVE ? ["active", "Active"] : ["done", "Completed"];

  return (
    <article className="group">
      <div className="group-top">
        <div>
          <div className="title-row">
            <h3>{g.name}</h3>
            <span className={`pill ${pill[0]}`}>{pill[1]}</span>
          </div>
          <p className="muted">{statusText}</p>
        </div>
        <div className="pot">
          <span className="pot-amount">{peso(potPhp)}</span>
          <span className="muted small">pot per round, {peso(lamportsToPhp(g.contribution))} each</span>
        </div>
      </div>

      <div
        className={`progress ${g.state === STATE.ACTIVE ? "active" : ""}`}
        role="progressbar"
        aria-label={g.state === STATE.OPEN ? "Members joined" : "Members paid this round"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <span style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>

      <Circle group={g} me={me} />

      <ul className="members">
        {g.members.map((m, i) => {
          const badge = badgeFor(g.contributions[i] || 0, roundsDone + (g.hasPaid(i) ? 1 : 0));
          const turn = g.payoutOrder.length ? g.payoutOrder.indexOf(i) + 1 : null;
          return (
            <li key={m.toBase58()} className={me && m.equals(me) ? "me" : undefined}>
              <Avatar pk={m} />
              <span className="who">
                {shortKey(m)}
                {me && m.equals(me) && <em className="you">you</em>}
                {g.creator.equals(m) && <em className="tag">creator</em>}
              </span>
              {turn && <span className="turn">Turn {turn}</span>}
              {g.state === STATE.ACTIVE && (
                <span className={g.hasPaid(i) ? "paid" : "unpaid"}>
                  {g.hasPaid(i) ? "Paid" : "Not yet"}
                </span>
              )}
              <span className={`badge ${badge.tier}`}>{badge.label}</span>
            </li>
          );
        })}
      </ul>

      <div className="actions">
        {g.state === STATE.OPEN && !isMember && n < g.maxMembers && (
          <button
            className="primary"
            disabled={!me || busy === `join-${id}`}
            onClick={() => send(`join-${id}`, () => joinGroupTx(g.address, me), `You joined ${g.name}.`)}
          >
            {busy === `join-${id}` ? <><Spinner /> Joining…</> : "Join group"}
          </button>
        )}

        {g.state === STATE.OPEN && isCreator && (
          <button
            className="primary"
            disabled={n < 2 || busy === `draw-${id}`}
            onClick={() =>
              send(`draw-${id}`, () => startAndDrawTx(g.address, me), "The bunutan is done. Payout order is set on-chain.")
            }
          >
            {busy === `draw-${id}` ? <><Spinner /> Drawing…</> : n < 2 ? "Need at least 2 members" : "Start and draw payout order"}
          </button>
        )}

        {g.state === STATE.ACTIVE && isMember && !g.hasPaid(myIdx) && (
          <button
            className="primary"
            disabled={busy === `pay-${id}`}
            onClick={() =>
              send(`pay-${id}`, () => contributeTx(g.address, me), `Paid ${peso(lamportsToPhp(g.contribution))} into the pot.`)
            }
          >
            {busy === `pay-${id}` ? <><Spinner /> Paying…</> : `Pay ${peso(lamportsToPhp(g.contribution))}`}
          </button>
        )}

        {g.state === STATE.ACTIVE && g.allPaid && (
          <button
            className="primary pot-btn"
            disabled={!me || busy === `payout-${id}`}
            onClick={() =>
              send(
                `payout-${id}`,
                () => payoutTx(g.address, g.currentWinner, me),
                `Sent ${peso(potPhp)} to ${shortKey(g.currentWinner)}.`
              )
            }
          >
            {busy === `payout-${id}` ? <><Spinner /> Sending…</> : `Release pot to ${shortKey(g.currentWinner)}`}
          </button>
        )}

        {g.state !== STATE.COMPLETED && (
          <button className="ghost" onClick={askCoach} disabled={coachBusy}>
            {coachBusy ? <><Spinner /> Thinking…</> : <>{Icon.sparkle} Ask the coach</>}
          </button>
        )}

        <a
          className="link"
          href={`https://explorer.solana.com/address/${id}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
        >
          See it on-chain {Icon.external}
        </a>
      </div>

      {coach && (
        <div className={`coach risk-${coach.risk}`}>
          <p className="risk">Coach · {coach.risk} risk</p>
          <p>{coach.summary}</p>
          {coach.advice && <p><strong>Next step:</strong> {coach.advice}</p>}
        </div>
      )}
    </article>
  );
}

// The memorable piece: members around the pot, in payout order once drawn.
function Circle({ group: g, me }) {
  const n = g.members.length;
  const slots = g.state === STATE.OPEN ? Math.max(g.maxMembers, n) : n;
  const order = g.payoutOrder.length ? g.payoutOrder : g.members.map((_, i) => i);
  const size = 220;
  const gid = `pot-${g.address.toBase58().slice(0, 8)}`;
  const r = 84;
  const c = size / 2;

  return (
    <div className="circle-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="circle" role="img"
        aria-label={`${n} members around the pot`}>
        <defs>
          <radialGradient id={gid} cx="35%" cy="30%" r="75%">
            <stop offset="0" stopColor="#ffe29a" />
            <stop offset="1" stopColor="#f5a524" />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c} r={r} className="ring" />
        <circle cx={c} cy={c} r={48} className="pot-glow" />
        <circle cx={c} cy={c} r={34} fill={`url(#${gid})`} />
        <text x={c} y={c + 5} textAnchor="middle" className="pot-text">
          {g.state === STATE.COMPLETED ? "Done" : g.state === STATE.OPEN ? "Open" : `R${g.currentRound + 1}`}
        </text>
        {Array.from({ length: slots }).map((_, pos) => {
          const angle = (pos / slots) * Math.PI * 2 - Math.PI / 2;
          const x = c + r * Math.cos(angle);
          const y = c + r * Math.sin(angle);
          const memberIdx = order[pos];
          const filled = memberIdx !== undefined && g.members[memberIdx];
          const isWinner = g.state === STATE.ACTIVE && pos === g.currentRound;
          const received = g.state !== STATE.OPEN && pos < g.currentRound;
          const paid = filled && g.state === STATE.ACTIVE && g.hasPaid(memberIdx);
          const mine = filled && me && g.members[memberIdx].equals(me);
          const cls = [
            "seat",
            !filled && "empty",
            paid && "paid",
            received && "received",
            isWinner && "winner",
            mine && "mine",
          ].filter(Boolean).join(" ");
          return (
            <g key={pos}>
              <circle cx={x} cy={y} r={isWinner ? 17 : 14} className={cls} />
              <text x={x} y={y + 4} textAnchor="middle" className="seat-text">
                {filled ? (g.payoutOrder.length ? pos + 1 : "•") : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="legend">
        <li><span className="key paid" /> Paid this round</li>
        <li><span className="key winner" /> Receives this round</li>
        <li><span className="key received" /> Already received</li>
      </ul>
    </div>
  );
}

// The AI agent: reads groups on-chain, decides, and releases pots with its own wallet.
function AgentPanel({ onDone }) {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/agent", { method: "POST" });
      const data = await readJson(res);
      setResult(data);
      await onDone();
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="panel agent">
      <h2><span className="icon-chip pot">{Icon.bot}</span>Paluwagan Agent</h2>
      <p className="muted small">
        An AI agent with its own wallet. It checks every group on-chain, releases
        pots when everyone has paid, and reminds members who haven't. The program
        still decides who gets paid, so the agent can't send money anywhere else.
      </p>
      <button className="primary block" onClick={run} disabled={running}>
        {running ? <><Spinner /> Agent is working…</> : <>{Icon.bot} Run the agent</>}
      </button>

      {result?.error && <p className="note error">{result.error}</p>}

      {result && !result.error && (
        <div className="agent-log">
          <div className="agent-meta">
            <span>Wallet {result.agent.slice(0, 4)}…{result.agent.slice(-4)}</span>
            <span>{result.balanceSol.toFixed(3)} SOL</span>
            {result.planner && <span>Planner: {result.planner}</span>}
          </div>
          {result.actions.length === 0 && <p className="note">{result.note || "Nothing to do right now."}</p>}
          {result.actions.map((a, i) => (
            <div key={i} className={`log-item ${a.action}`}>
              <strong>{a.group}</strong>
              <span>{a.message}</span>
              {a.signature && (
                <a
                  className="link"
                  href={`https://explorer.solana.com/tx/${a.signature}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View payout on Explorer {Icon.external}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function countPaid(g) {
  return g.members.filter((_, i) => g.hasPaid(i)).length;
}

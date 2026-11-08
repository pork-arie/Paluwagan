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

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="coin" aria-hidden="true">🪙</span>
          <span>Paluwagan</span>
          <span className="net">Devnet</span>
        </div>
        <WalletMultiButton />
      </header>

      <section className="hero">
        <h1>Ipon nang walang takbuhan.</h1>
        <p>
          A paluwagan where the pot is held by a Solana program, not a person.
          Everyone sees who has paid, the payout order is drawn on-chain, and
          the pot goes straight to the right member. Nobody can run away with it.
        </p>
      </section>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span>{toast.text}</span>
          {toast.sig && (
            <a
              href={`https://explorer.solana.com/tx/${toast.sig}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              View on Solana Explorer
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
            <h2>Groups</h2>
            <button className="ghost" onClick={refresh}>Refresh</button>
          </div>
          {loading && <p className="muted">Loading groups from Solana…</p>}
          {!loading && groups.length === 0 && (
            <p className="empty">No groups yet. Start the first one on the left.</p>
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
      setCoachNote({ kind: "ok", text: `${data.explanation} (${data.schedule})` });
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
      <h2>Start a paluwagan</h2>

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
      <button className="secondary" onClick={askCoach} disabled={!text.trim() || coachBusy}>
        {coachBusy ? "Asking the coach…" : "Ask the coach"}
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
        <p className="muted small">
          Each round's pot: <strong>{peso(pot)}</strong> (
          {lamportsToSol(phpToLamports(pot)).toFixed(3)} SOL). Every member receives it once.
        </p>
        <button className="primary" disabled={!wallet.publicKey || busy === "create"}>
          {busy === "create" ? "Creating…" : wallet.publicKey ? "Create group" : "Connect wallet to create"}
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

  return (
    <article className="group">
      <div className="group-top">
        <div>
          <h3>{g.name}</h3>
          <p className="muted">{statusText}</p>
        </div>
        <div className="pot">
          <span className="pot-amount">{peso(potPhp)}</span>
          <span className="muted small">pot per round, {peso(lamportsToPhp(g.contribution))} each</span>
        </div>
      </div>

      <Circle group={g} me={me} />

      <ul className="members">
        {g.members.map((m, i) => {
          const badge = badgeFor(g.contributions[i] || 0, roundsDone + (g.hasPaid(i) ? 1 : 0));
          const turn = g.payoutOrder.length ? g.payoutOrder.indexOf(i) + 1 : null;
          return (
            <li key={m.toBase58()}>
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
            {busy === `join-${id}` ? "Joining…" : "Join group"}
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
            {busy === `draw-${id}` ? "Drawing…" : n < 2 ? "Need at least 2 members" : "Start and draw payout order"}
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
            {busy === `pay-${id}` ? "Paying…" : `Pay ${peso(lamportsToPhp(g.contribution))}`}
          </button>
        )}

        {g.state === STATE.ACTIVE && g.allPaid && (
          <button
            className="primary"
            disabled={!me || busy === `payout-${id}`}
            onClick={() =>
              send(
                `payout-${id}`,
                () => payoutTx(g.address, g.currentWinner, me),
                `Sent ${peso(potPhp)} to ${shortKey(g.currentWinner)}.`
              )
            }
          >
            {busy === `payout-${id}` ? "Sending…" : `Release pot to ${shortKey(g.currentWinner)}`}
          </button>
        )}

        {g.state !== STATE.COMPLETED && (
          <button className="ghost" onClick={askCoach} disabled={coachBusy}>
            {coachBusy ? "Thinking…" : "Ask the coach"}
          </button>
        )}

        <a
          className="link"
          href={`https://explorer.solana.com/address/${id}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
        >
          See it on-chain
        </a>
      </div>

      {coach && (
        <div className={`coach risk-${coach.risk}`}>
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
  const r = 84;
  const c = size / 2;

  return (
    <div className="circle-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="circle" role="img"
        aria-label={`${n} members around the pot`}>
        <circle cx={c} cy={c} r={r} className="ring" />
        <circle cx={c} cy={c} r={34} className="pot-dot" />
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
      <h2>Paluwagan Agent</h2>
      <p className="muted small">
        An AI agent with its own wallet. It checks every group on-chain, releases
        pots when everyone has paid, and reminds members who haven't. The program
        still decides who gets paid, so the agent can't send money anywhere else.
      </p>
      <button className="secondary" onClick={run} disabled={running}>
        {running ? "Agent is working…" : "Run the agent"}
      </button>

      {result?.error && <p className="note error">{result.error}</p>}

      {result && !result.error && (
        <div className="agent-log">
          <p className="muted small">
            Agent wallet {result.agent.slice(0, 4)}…{result.agent.slice(-4)} ·{" "}
            {result.balanceSol.toFixed(3)} SOL
            {result.planner && <> · planned by {result.planner}</>}
          </p>
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
                  View payout on Explorer
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

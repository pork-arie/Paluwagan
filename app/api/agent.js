// Paluwagan Agent: an AI agent with its own Solana wallet.
// 1. Reads every group from the chain.
// 2. Gemini decides what each active group needs: release the pot, remind members, or wait.
// 3. The agent executes payouts on-chain itself. The program still enforces the rules,
//    so the agent can only send a pot to the winner the draw already chose.
//
// POST /api/agent  -> { agent, balanceSol, actions: [...] }

// Dependencies are loaded with dynamic import() inside the handler's try/catch,
// so a module-load failure comes back as JSON instead of Vercel's plain-text
// "A server error has occurred" page.

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group: { type: "string", description: "The group address exactly as given" },
          action: { type: "string", enum: ["payout", "remind", "wait"] },
          message: {
            type: "string",
            description: "Short Taglish message for the group: what you did or a friendly reminder naming who still needs to pay",
          },
        },
        required: ["group", "action", "message"],
      },
    },
  },
  required: ["actions"],
};

function loadAgent(Keypair) {
  let raw = (process.env.AGENT_SECRET_KEY || "").trim();
  if (!raw) throw new Error("AGENT_SECRET_KEY is not set. Run `npm run agent:new` and add it to your env.");
  // Tolerate the value being pasted with surrounding quotes or the "AGENT_SECRET_KEY=" prefix.
  raw = raw.replace(/^AGENT_SECRET_KEY=/, "").replace(/^['"]|['"]$/g, "").trim();
  let bytes;
  try {
    bytes = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_SECRET_KEY must be a JSON array like [12,34,...] (the output of `npm run agent:new`).");
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`AGENT_SECRET_KEY must be an array of 64 numbers, got ${Array.isArray(bytes) ? bytes.length : typeof bytes}.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

// If Gemini is unavailable, fall back to simple rules so the agent still works.
function rulePlan(groups) {
  return groups.map((g) => ({
    group: g.address,
    action: g.allPaid ? "payout" : "remind",
    message: g.allPaid
      ? `Kumpleto na ang bayad! Ipinadala na ang pot kay ${g.winner}.`
      : `Paalala: ${g.unpaid.join(", ")}, kayo na lang ang kulang ngayong round.`,
  }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { Connection, Keypair, clusterApiUrl } = await import("@solana/web3.js");
    const { askGemini } = await import("./_gemini.js");
    const { STATE, fetchGroups, lamportsToPhp, payoutTx, shortKey } = await import("../src/lib/paluwagan.js");

    const agent = loadAgent(Keypair);
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    const balance = await connection.getBalance(agent.publicKey);

    const all = await fetchGroups(connection);
    const active = all.filter((g) => g.state === STATE.ACTIVE);

    // A compact view of each group for the model
    const view = active.map((g) => ({
      address: g.address.toBase58(),
      name: g.name,
      round: g.currentRound + 1,
      totalRounds: g.members.length,
      contributionPhp: lamportsToPhp(g.contribution),
      allPaid: g.allPaid,
      unpaid: g.members.filter((_, i) => !g.hasPaid(i)).map(shortKey),
      winner: g.currentWinner ? shortKey(g.currentWinner) : null,
    }));

    if (view.length === 0) {
      return res.status(200).json({
        agent: agent.publicKey.toBase58(),
        balanceSol: balance / 1e9,
        actions: [],
        note: "No active groups right now.",
      });
    }

    let plan;
    let planner = "gemini";
    try {
      const result = await askGemini(
        `You are the Paluwagan Agent. You hold a Solana wallet and can release a group's pot on-chain. ` +
          `For each active group below decide one action:\n` +
          `- "payout" ONLY if allPaid is true\n- "remind" if some members have not paid\n- "wait" otherwise.\n` +
          `Write each message in short, friendly Taglish.\n\nGroups:\n${JSON.stringify(view)}`,
        PLAN_SCHEMA
      );
      plan = result.actions;
    } catch (e) {
      planner = "rules (Gemini unavailable)";
      plan = rulePlan(view);
    }

    const actions = [];
    for (const step of plan) {
      const g = active.find((x) => x.address.toBase58() === step.group);
      if (!g) continue;

      if (step.action === "payout") {
        // Guardrail: double-check the chain before acting, never trust the model alone.
        if (!g.allPaid) {
          actions.push({ group: g.name, action: "skipped", message: "Not everyone has paid yet, so the agent waited." });
          continue;
        }
        try {
          const tx = await payoutTx(g.address, g.currentWinner, agent.publicKey);
          tx.feePayer = agent.publicKey;
          const latest = await connection.getLatestBlockhash();
          tx.recentBlockhash = latest.blockhash;
          tx.sign(agent);
          const sig = await connection.sendRawTransaction(tx.serialize());
          await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
          actions.push({ group: g.name, action: "payout", message: step.message, signature: sig });
        } catch (e) {
          actions.push({ group: g.name, action: "failed", message: `Payout failed: ${e.message}` });
        }
      } else {
        actions.push({ group: g.name, action: step.action, message: step.message });
      }
    }

    return res.status(200).json({
      agent: agent.publicKey.toBase58(),
      balanceSol: balance / 1e9,
      planner,
      actions,
    });
  } catch (err) {
    console.error("[agent]", err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}

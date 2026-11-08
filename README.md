# Paluwagan: savings circles nobody can run away with

A **paluwagan** is a Filipino rotating savings group. Every member puts in the same amount each round, and each round one member takes home the whole pot. It is how millions of Filipinos save for tuition, a sari-sari store restock, or an emergency.

The problem: the organizer holds the money. Paluwagan scams, where the organizer disappears with everyone's savings, are common and hurt the people who can least afford it.

**This app moves the pot from a person to a Solana program.** Contributions go into an account only the program can move. The payout order is drawn on-chain. When everyone has paid, the program sends the pot to that round's winner, and nobody can redirect it.

## Features

- **Trustless pot (DeFi):** contributions are held by the program, and payouts follow fixed rules. No organizer can take the money.
- **On-chain bunutan (Gaming):** the payout order is shuffled on-chain when the group starts, and every member can verify it.
- **Suki badges (Gaming):** Bronze, Silver, and Gold badges based on each member's on-chain contribution record.
- **Paluwagan Agent (AI, on-chain):** an AI agent with its own Solana wallet. It reads every group on-chain, Gemini decides what each group needs, and the agent releases pots itself when everyone has paid. It double-checks the chain before acting, and the program only lets it pay the winner the draw already chose.
- **Paluwagan Coach (AI):** describe your group in Taglish ("6 kami, ₱300 kada Biyernes") and Gemini fills in the setup. The coach can also explain a group's status and suggest a next step.
- **Fully transparent:** every action links to Solana Explorer.

## How it works

| Instruction | Who | What happens |
|---|---|---|
| `create_group` | Creator | Opens a group with a name, contribution, and member limit |
| `join_group` | Anyone | Joins while the group is open |
| `start_and_draw` | Creator | Locks the group and shuffles the payout order on-chain |
| `contribute` | Member | Sends this round's contribution into the program-held pot |
| `payout` | Anyone | When all members have paid, sends the pot to this round's winner |

## Tech

- Solana program in Rust with Anchor, deployed to devnet
- React + Vite frontend with Solana Wallet Adapter (Phantom)
- Gemini API (structured output) through a Vercel serverless function
- Instructions are encoded directly from Anchor discriminators, so the frontend has no IDL dependency

## Run it

### 1. Deploy the program
1. Open https://beta.solpg.io and create a new **Anchor** project.
2. Replace `src/lib.rs` with `program/lib.rs`.
3. Bottom-left: connect the Playground wallet and set the cluster to **devnet**.
4. In the terminal: `solana airdrop 2` (or use https://faucet.solana.com).
5. Click **Build**, then **Deploy**. Copy the **Program ID**.

### 2. Run the app
```
cd app
cp .env.example .env     # paste your Program ID and Gemini key
npm install
npx vercel dev           # runs the app and /api/coach together
```
`npm run dev` also works, but the coach endpoint only runs under `vercel dev` or on Vercel.

### 3. Set up the agent
```
npm run agent:new
```
Copy the printed `AGENT_SECRET_KEY=...` line into `.env`, then send the agent about 0.1 devnet SOL for fees:
```
solana transfer AGENT_ADDRESS 0.1 --allow-unfunded-recipient
```

### 4. Deploy
Push to GitHub, import the repo in Vercel with **Root Directory = app**, and add `VITE_PROGRAM_ID`, `VITE_PHP_PER_SOL`, `GEMINI_API_KEY`, and `AGENT_SECRET_KEY` as environment variables.

## Limitations and next steps

- The draw uses slot and timestamp hashing. For production it should use verifiable randomness (e.g., Switchboard VRF).
- Amounts use a fixed demo peso rate. Production would use a USDC stablecoin so contributions don't change in value.
- Next: round deadlines with late flags, GCash-to-USDC on-ramp, and SMS reminders.

Built for the MLH Solana Hackathon, November 2026.

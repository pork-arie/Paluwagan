// Creates a new devnet wallet for the Paluwagan Agent.
import { Keypair } from "@solana/web3.js";
const kp = Keypair.generate();
console.log("\nAgent wallet address (fund this with ~0.1 devnet SOL):");
console.log(kp.publicKey.toBase58());
console.log("\nAdd this line to your .env (and to Vercel env vars). Keep it secret:");
console.log(`AGENT_SECRET_KEY=${JSON.stringify(Array.from(kp.secretKey))}\n`);

import * as os from "node:os";
import * as readline from "node:readline";

/**
 * `harness login` — one-time BYO credential registration for the hosted model.
 * Posts the caller's OWN Claude key/subscription token to the llm-gateway, which
 * forwards it upstream on their behalf. The secret is sent once over HTTPS and is
 * NEVER printed or written to the local disk by this command.
 *
 * Local-only users never need this: local `harness run` uses ANTHROPIC_API_KEY
 * (or a logged-in `claude` CLI) directly, with no gateway and no cloud.
 */
export async function login(flags: Record<string, unknown>): Promise<number> {
  const gateway = (flags.gateway as string) ?? process.env.HARNESS_LLM_GATEWAY;
  if (!gateway) {
    console.error(
      "usage: harness login --gateway <url> [--key <sk-...> | --oauth <token>]\n" +
        "  (or set HARNESS_LLM_GATEWAY). Local-only? You don't need this — just set ANTHROPIC_API_KEY.",
    );
    return 1;
  }
  const identity = (flags.identity as string) ?? process.env.HARNESS_IDENTITY ?? `${os.userInfo().username}@firm.local`;

  let apiKey = (flags.key as string) ?? undefined;
  let oauthToken = (flags.oauth as string) ?? undefined;
  if (!apiKey && !oauthToken) {
    // Prompt without echoing to the terminal history in an obvious way.
    apiKey = await prompt("Paste your Claude API key (sk-...): ");
  }
  const body = apiKey ? { apiKey } : { oauthToken };

  const res = await fetch(new URL("/v1/keys", gateway), {
    method: "POST",
    headers: { "content-type": "application/json", "x-firm-identity": identity },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`login failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return 1;
  }
  const out = (await res.json()) as { credential?: string; endsWith?: string };
  console.log(`✓ registered ${out.credential ?? "credential"} for ${identity} (ends …${out.endsWith ?? "****"}). You're set — build away.`);
  return 0;
}

function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => {
    rl.close();
    resolve(a.trim());
  }));
}

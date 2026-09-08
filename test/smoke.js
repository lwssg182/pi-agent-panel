"use strict";

/**
 * Headless smoke test for the RPC client layer.
 * Only calls `get_state` — no LLM request, no token cost.
 *
 * Usage: node test/smoke.js
 */

const { PiRpcClient } = require("../pi-rpc");

async function main() {
  const client = new PiRpcClient({ args: ["--no-session"] });

  let sawEvent = false;
  client.on("event", () => {
    sawEvent = true;
  });
  client.on("ui", (req) => {
    // Auto-respond so nothing can hang if pi asks for interaction.
    if (req.method === "confirm") client.respondUi(req.id, { confirmed: true });
    else client.respondUi(req.id, { cancelled: true });
  });

  client.start();
  console.log("pi binary:", client.piPath);

  const state = await client.request({ type: "get_state" });
  const model = state.model ? `${state.model.provider}/${state.model.id}` : "(none)";
  console.log("model:", model);
  console.log("sessionFile:", state.sessionFile);
  console.log("isStreaming:", state.isStreaming);
  console.log("sawEvent:", sawEvent);

  console.log("OK");
  client.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});

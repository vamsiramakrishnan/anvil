// The bridge command/configuration belongs to the operator, never browser input.
// ANVIL_AGENT_BRIDGE names an executable implementing anvil-fuzz-agent/v1.
import { processAgent } from "@anvil/fuzz";
import { ownedBusinessEvaluator } from "@anvil/harness";
if (!process.env.ANVIL_AGENT_BRIDGE || !process.env.ANVIL_AGENT_MODEL)
  throw new Error("Set ANVIL_AGENT_BRIDGE and ANVIL_AGENT_MODEL for the real agent harness.");
export default ownedBusinessEvaluator(processAgent({
  command: process.env.ANVIL_AGENT_BRIDGE,
  args: JSON.parse(process.env.ANVIL_AGENT_ARGS ?? "[]"),
}, { model: process.env.ANVIL_AGENT_MODEL, configuration: process.env.ANVIL_AGENT_CONFIG_VERSION ?? "operator-configured" }));

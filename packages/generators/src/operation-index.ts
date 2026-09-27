import type { AirDocument, Operation } from "@anvil/air";

/**
 * The skill is the *exposed* surface, so capability docs must resolve only
 * **approved** member operations — never advertise operations that approval has
 * not yet exposed. Capabilities with no approved members are omitted entirely.
 */
export function approvedMembers(
  air: AirDocument,
  cap: AirDocument["capabilities"][number],
): Operation[] {
  const byId = operationsById(air);
  return cap.operationIds
    .map((id) => byId.get(id))
    .filter((o): o is Operation => Boolean(o) && o?.state === "approved");
}

/**
 * Operation lookup by id, built once per AIR document (a whole-source compile
 * of a large contract has tens of thousands of operations and thousands of
 * capabilities). The first operation wins, as `Array.find` did.
 */
const operationIndex = new WeakMap<AirDocument["operations"], Map<string, Operation>>();
export function operationsById(air: AirDocument): Map<string, Operation> {
  let index = operationIndex.get(air.operations);
  if (!index) {
    index = new Map();
    for (const op of air.operations) if (!index.has(op.id)) index.set(op.id, op);
    operationIndex.set(air.operations, index);
  }
  return index;
}

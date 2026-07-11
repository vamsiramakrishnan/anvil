import type { Command } from "commander";

/**
 * Anvil-specific metadata for a Commander command. The Commander tree is the
 * single owner of path, arguments, options, and help text; anything Commander
 * cannot express (does the command mutate disk/cloud state?) attaches to the
 * command object itself via this WeakMap — never a second standalone registry
 * that could drift from the tree.
 */
export interface AnvilCommandMeta {
  /** Does this command have side effects on disk / cloud? */
  mutates: boolean;
}

const META = new WeakMap<Command, AnvilCommandMeta>();

/** Attach Anvil metadata to a command, beside its declaration. */
export function annotate<T extends Command>(command: T, meta: AnvilCommandMeta): T {
  META.set(command, meta);
  return command;
}

/** Read a command's Anvil metadata (undefined for unannotated commands). */
export function metaOf(command: Command): AnvilCommandMeta | undefined {
  return META.get(command);
}

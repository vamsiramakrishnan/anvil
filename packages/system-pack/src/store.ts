/**
 * The content-addressed store abstraction. A pack's artifact bytes live behind
 * this interface, keyed by their content digest, so a durable backend (e.g.
 * `cacache` on disk) can replace the in-memory store at a composition boundary
 * without changing pack identity. The core never invents a cache database; it
 * depends on this seam and lets the shell choose the backend.
 */
import { contentDigest } from "./digest.js";

export interface ArtifactStore {
  /** Store bytes; returns their content digest (the key). */
  put(bytes: Uint8Array): string;
  /** Retrieve bytes by content digest, or undefined if absent. */
  get(digest: string): Uint8Array | undefined;
  has(digest: string): boolean;
}

/** A process-local content-addressed store. Deterministic and side-effect-free. */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly byDigest = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): string {
    const digest = contentDigest(bytes);
    if (!this.byDigest.has(digest)) this.byDigest.set(digest, bytes);
    return digest;
  }

  get(digest: string): Uint8Array | undefined {
    return this.byDigest.get(digest);
  }

  has(digest: string): boolean {
    return this.byDigest.has(digest);
  }
}

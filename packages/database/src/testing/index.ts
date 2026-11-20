import { MemoryStore } from "../memory";

/** Fresh, empty store with Firestore semantics, for tests. */
export function createTestStore(): MemoryStore {
  return new MemoryStore();
}

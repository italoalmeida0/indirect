import { createServer } from "node:net";

/** Returns a free TCP port on 127.0.0.1. Test suites use this instead of
 * hardcoded ports so two concurrent `bun test` runs (or a leftover process)
 * can never collide on bind. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no address")));
      }
    });
  });
}

import { totpAt } from "../server/crypto";

/** Exercise distinct accepted skew windows without sleeping or replaying a
 * proof already consumed by enrollment/login. Recompute at each operation. */
export async function unusedTotpCode(secret: string, consumed: Set<string>): Promise<string> {
  const now = Date.now();
  for (const offset of [0, 30_000, -30_000]) {
    const code = await totpAt(secret, now + offset);
    if (!consumed.has(code)) { consumed.add(code); return code; }
  }
  throw new Error("all accepted TOTP windows were consumed in this test");
}

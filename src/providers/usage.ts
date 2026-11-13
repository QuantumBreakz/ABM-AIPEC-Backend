// Hard monthly caps for paid providers, tracked in Mongo so a bug or a big run can never spend past them.
import { Usage } from '../db/models.js';

/** Take one unit of this month's allowance for `provider`. False = the cap is reached. */
export async function takeUsage(provider: string, max: number): Promise<boolean> {
  if (max <= 0) return false;
  const period = new Date().toISOString().slice(0, 7);
  try {
    const doc = await Usage.findOneAndUpdate(
      { provider, period, count: { $lt: max } },
      { $inc: { count: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return !!doc;
  } catch (e: any) {
    if (e?.code === 11000) return false; // this month's doc exists and is at the cap, so the upsert collided
    throw e;
  }
}

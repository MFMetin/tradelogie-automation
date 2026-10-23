import fs from 'node:fs';
import { deleteAllTestUsers } from '../db/users';
import { closePool } from '../db/pool';
import { ADMIN_STATE } from './globalSetup';

/**
 * Leaves the database as it was found. Setup also cleans, so a crashed run
 * still cannot poison the next one — this half is about not leaving a working
 * admin token sitting on disk.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    const removed = await deleteAllTestUsers();
    if (removed > 0) console.log(`[teardown] removed ${removed} test account(s)`);
  } finally {
    await closePool();
    fs.rmSync(ADMIN_STATE, { force: true });
  }
}

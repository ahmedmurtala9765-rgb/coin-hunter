// @ts-nocheck
// @ts-nocheck
import { log } from './index';

export async function backupToSupabase() {
  // Backup disabled per user request
  return;
}

export async function restoreFromSupabase() {
  // Restore disabled per user request
  return false;
}

export async function setupBackupInterval() {
  // Backup system: Disabled (Running in local-only mode)
  log("Backup system: Disabled (Running in local-only mode)", "backup");
}

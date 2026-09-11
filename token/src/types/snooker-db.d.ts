/**
 * Minimal ambient types for the plain-JS @snooker/db workspace package.
 * Only the surface the token scripts actually touch.
 */
declare module '@snooker/db' {
  import type { Knex } from 'knex';

  export function getDb(): Knex;
  export function closeDb(): Promise<void>;
  export function migrate(): Promise<void>;
  export function userById(id: number): Promise<Record<string, unknown> | undefined>;
  export function activeWallet(userId: number): Promise<Record<string, unknown> | undefined>;
}

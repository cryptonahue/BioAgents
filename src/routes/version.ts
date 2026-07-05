/**
 * Version endpoint — exposes build metadata for the client Footer.
 * No auth: this is public build info (not sensitive).
 */

import { Elysia } from 'elysia';
import { getVersion } from '../version';

export const versionRoute = new Elysia({ prefix: '/api' })
  .get('/version', () => {
    return getVersion();
  });

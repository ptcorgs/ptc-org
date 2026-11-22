import { createClient, type Client } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { ORGANIZATIONS, getOrgByCode } from '../config/org-config.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const ORG_DB_DIR = path.join(DATA_DIR, 'orgs');

const orgClients = new Map<string, Client>();
let centralClient: Client | null = null;

function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ORG_DB_DIR)) {
    fs.mkdirSync(ORG_DB_DIR, { recursive: true });
  }
}

/**
 * Dynamic Turso / libSQL Client Helper
 * Resolves dedicated Turso credentials from environment variables (TURSO_DATABASE_URL_<CODE>)
 * or provisions an isolated 1-to-1 local SQLite database file per organization.
 */
export function getOrgDb(orgCode: string): Client {
  const org = getOrgByCode(orgCode);
  if (!org) {
    throw new Error(`Unknown organization code: ${orgCode}`);
  }

  const cached = orgClients.get(org.code);
  if (cached) return cached;

  const envUrl = process.env[org.envUrlKey];
  const envToken = process.env[org.envTokenKey];

  let client: Client;
  if (envUrl) {
    client = createClient({
      url: envUrl,
      authToken: envToken || undefined,
    });
  } else {
    ensureDataDirs();
    client = createClient({
      url: `file:${path.join(ORG_DB_DIR, `org_${org.code}.db`)}`,
    });
  }

  orgClients.set(org.code, client);
  return client;
}

/**
 * Central CESSCA Administration & Global Moderation Queue Client
 */
export function getCentralDb(): Client {
  if (centralClient) return centralClient;

  const envUrl = process.env.TURSO_DATABASE_URL_CESSCA;
  const envToken = process.env.TURSO_AUTH_TOKEN_CESSCA;

  if (envUrl) {
    centralClient = createClient({
      url: envUrl,
      authToken: envToken || undefined,
    });
  } else {
    ensureDataDirs();
    centralClient = createClient({
      url: `file:${path.join(DATA_DIR, 'cessca_central.db')}`,
    });
  }

  return centralClient;
}

const LEGACY_MOCK_POSTS = [
  { id: 'post_ssc_001', orgCode: 'ssc' },
  { id: 'post_jpcs_001', orgCode: 'jpcs' },
  { id: 'post_athletes_001', orgCode: 'athletes' },
  { id: 'post_plumage_001', orgCode: 'plumage' },
  { id: 'post_image_001', orgCode: 'image' },
  { id: 'post_jpcs_pending_002', orgCode: 'jpcs' },
  { id: 'post_dlc_pending_001', orgCode: 'dlc' },
  { id: 'post_chambers_pending_001', orgCode: 'chambers' },
] as const;

let initialized = false;
let initializationPromise: Promise<void> | null = null;

export function initializeAllDatabases(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initializationPromise) return initializationPromise;

  initializationPromise = initializeDatabases().catch((error: unknown) => {
    initializationPromise = null;
    throw error;
  });
  return initializationPromise;
}

async function initializeDatabases() {
  if (process.env.VERCEL) {
    const requiredVariables = [
      'TURSO_DATABASE_URL_CESSCA',
      'TURSO_AUTH_TOKEN_CESSCA',
      ...ORGANIZATIONS.flatMap((org) => [org.envUrlKey, org.envTokenKey]),
    ];
    const missingVariables = requiredVariables.filter((key) => !process.env[key]?.trim());
    if (missingVariables.length > 0) {
      throw new Error(
        `Missing required Vercel database environment variables: ${missingVariables.join(', ')}`
      );
    }
  }

  const central = getCentralDb();
  await Promise.all([
    (async () => {
      await central.execute(`
        CREATE TABLE IF NOT EXISTS cessca_queue (
          id TEXT PRIMARY KEY,
          letter_ref TEXT NOT NULL,
          org_code TEXT NOT NULL,
          org_short_name TEXT NOT NULL,
          org_full_name TEXT NOT NULL,
          president_name TEXT NOT NULL,
          title TEXT NOT NULL,
          event_date TEXT NOT NULL,
          caption TEXT NOT NULL,
          image_url TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          feedback TEXT,
          submitted_at TEXT NOT NULL,
          reviewed_at TEXT,
          reviewed_by TEXT
        )
      `);

      await central.execute(`
        CREATE TABLE IF NOT EXISTS portal_live_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL
        )
      `);
      await central.execute(`
        CREATE TABLE IF NOT EXISTS proposal_submissions (
          id TEXT PRIMARY KEY,
          org_code TEXT NOT NULL,
          org_short_name TEXT NOT NULL,
          org_full_name TEXT NOT NULL,
          president_name TEXT NOT NULL,
          submitted_by_uid TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          file_name TEXT NOT NULL,
          pathname TEXT NOT NULL,
          content_type TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          submitted_at TEXT NOT NULL
        )
      `);
      const proposalColumns = await central.execute('PRAGMA table_info(proposal_submissions)');
      const existingProposalColumns = new Set(
        proposalColumns.rows.map((column) => String(column.name))
      );
      for (const [column, definition] of [
        ['status', "TEXT NOT NULL DEFAULT 'pending'"],
        ['feedback', 'TEXT'],
        ['reviewed_at', 'TEXT'],
        ['reviewed_by', 'TEXT'],
      ]) {
        if (!existingProposalColumns.has(column)) {
          await central.execute(
            `ALTER TABLE proposal_submissions ADD COLUMN ${column} ${definition}`
          );
        }
      }
      await central.execute(
        'INSERT OR IGNORE INTO portal_live_version (id, version) VALUES (1, 0)'
      );
    })(),
    Promise.all(
      ORGANIZATIONS.map(async (org) => {
        const db = getOrgDb(org.code);
        await db.execute(`
          CREATE TABLE IF NOT EXISTS posts (
            id TEXT PRIMARY KEY,
            letter_ref TEXT NOT NULL,
            org_code TEXT NOT NULL,
            author_name TEXT NOT NULL,
            title TEXT NOT NULL,
            event_date TEXT NOT NULL,
            caption TEXT NOT NULL,
            image_url TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            feedback TEXT,
            likes_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            reviewed_at TEXT
          )
        `);
        await db.execute(`
          CREATE TABLE IF NOT EXISTS organization_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            banner_data_url TEXT,
            avatar_data_url TEXT,
            about_text TEXT,
            organization_name TEXT,
            organization_short_name TEXT,
            president_name TEXT,
            facebook_url TEXT,
            updated_at TEXT NOT NULL
          )
        `);
        const profileColumns = await db.execute('PRAGMA table_info(organization_profile)');
        const existingColumns = new Set(profileColumns.rows.map((column) => String(column.name)));
        for (const column of [
          'about_text',
          'organization_name',
          'organization_short_name',
          'president_name',
          'facebook_url',
        ]) {
          if (!existingColumns.has(column)) {
            await db.execute(`ALTER TABLE organization_profile ADD COLUMN ${column} TEXT`);
          }
        }
      })
    ),
  ]);

  const mockPostIds = LEGACY_MOCK_POSTS.map((post) => post.id);
  const placeholders = mockPostIds.map(() => '?').join(', ');
  const [centralCleanup, orgCleanupResults] = await Promise.all([
    central.execute({
      sql: `DELETE FROM cessca_queue WHERE id IN (${placeholders})`,
      args: mockPostIds,
    }),
    Promise.all(
      ORGANIZATIONS.map(async (org) => {
        const orgMockPostIds = LEGACY_MOCK_POSTS
          .filter((post) => post.orgCode === org.code)
          .map((post) => post.id);
        if (orgMockPostIds.length === 0) return 0;

        const orgPlaceholders = orgMockPostIds.map(() => '?').join(', ');
        const result = await getOrgDb(org.code).execute({
          sql: `DELETE FROM posts WHERE id IN (${orgPlaceholders})`,
          args: orgMockPostIds,
        });
        return result.rowsAffected;
      })
    ),
  ]);
  const removedMockPosts =
    centralCleanup.rowsAffected + orgCleanupResults.reduce((total, count) => total + count, 0);

  if (removedMockPosts > 0) {
    await central.execute(
      'UPDATE portal_live_version SET version = version + 1 WHERE id = 1'
    );
  }

  initialized = true;
}

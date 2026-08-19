require('dotenv').config();
const { Pool } = require('pg');

function normalizeDatabaseUrl(url) {
  if (!url) return null;

  const usePooler = process.env.USE_DATABASE_POOLER === 'true' || process.env.NODE_ENV === 'production';
  const pooledUrl = process.env.DATABASE_URL_POOLER || process.env.SUPABASE_POOLER_URL;

  if (usePooler && pooledUrl) {
    return pooledUrl;
  }

  return url;
}

function isSupabaseUrl(url) {
  return typeof url === 'string' && /supabase\.co/i.test(url);
}

function getSslOptions(url, env) {
  const sslEnabled = process.env.DATABASE_SSL
    ? process.env.DATABASE_SSL !== 'false'
    : isSupabaseUrl(url) || env === 'production';

  if (!sslEnabled) return false;

  return {
    rejectUnauthorized: false,
  };
}

function buildConfig(url, env, pool) {
  const normalizedUrl = normalizeDatabaseUrl(url);
  return {
    url: normalizedUrl,
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: getSslOptions(normalizedUrl, env),
    },
    pool: {
      max: parseInt(process.env.DATABASE_POOL_MAX || pool.max, 10),
      min: parseInt(process.env.DATABASE_POOL_MIN || pool.min, 10),
      acquire: parseInt(process.env.DATABASE_POOL_ACQUIRE || pool.acquire, 10),
      idle: parseInt(process.env.DATABASE_POOL_IDLE || pool.idle, 10),
    },
  };
}

// Shared pg.Pool for the Postgres-backed session store (connect-pg-simple).
// Reuses the same URL normalization and SSL rules as the Sequelize config.
function getPgPool(max = 10) {
  const url = normalizeDatabaseUrl(process.env.DATABASE_URL);
  const ssl = getSslOptions(url, process.env.NODE_ENV || 'development');
  return new Pool({
    connectionString: url,
    ssl,
    max: parseInt(process.env.DATABASE_POOL_MAX || max, 10),
    min: parseInt(process.env.DATABASE_POOL_MIN || 0, 10),
    idleTimeoutMillis: parseInt(process.env.DATABASE_POOL_IDLE || 10000, 10),
    connectionTimeoutMillis: 10000,
  });
}

module.exports = {
  getPgPool,
  development: buildConfig(process.env.DATABASE_URL, 'development', {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  }),
  test: buildConfig(process.env.DATABASE_URL_TEST || process.env.DATABASE_URL, 'test', {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  }),
  production: buildConfig(process.env.DATABASE_URL, 'production', {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  }),
};

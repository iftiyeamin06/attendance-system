require('dotenv').config();

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

module.exports = {
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

let memoryCache = new Map();

let redisClient = null;
let redisAvailable = null;

async function initRedis() {
  if (redisAvailable !== null) return redisAvailable;

  try {
    const redis = require('redis');
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = redis.createClient({
      url,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: () => null,
      },
      maxReconnectAfterLastError: 1,
    });

    redisClient.on('error', () => {});

    await redisClient.connect();
    redisAvailable = true;
    console.log('[cache] Redis connected');
    return true;
  } catch (err) {
    console.warn('[cache] Redis not available. Using in-memory cache.');
    redisAvailable = false;
    redisClient = null;
    return false;
  }
}

const connectWithTimeout = () => {
  return Promise.race([
    initRedis(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis connection timeout')), 3000)
    ),
  ]).catch((err) => {
    console.warn('[cache] Redis not available. Using in-memory cache.');
    redisAvailable = false;
    redisClient = null;
    return false;
  });
};

const cache = {
  init: connectWithTimeout,

  async get(key) {
    if (redisAvailable === false) {
      const cached = memoryCache.get(key);
      return cached ? JSON.parse(cached) : null;
    }

    if (redisAvailable) {
      try {
        const val = await redisClient.get(key);
        return val ? JSON.parse(val) : null;
      } catch (err) {
        return null;
      }
    }

    const cached = memoryCache.get(key);
    return cached ? JSON.parse(cached) : null;
  },

  async set(key, value, ttlSeconds = 3600) {
    const serialized = JSON.stringify(value);

    if (redisAvailable) {
      try {
        await redisClient.setEx(key, ttlSeconds, serialized);
        return;
      } catch (err) {
      }
    }
    memoryCache.set(key, serialized);
  },

  async del(key) {
    if (redisAvailable) {
      try {
        await redisClient.del(key);
      } catch (err) {
      }
    }
    memoryCache.delete(key);
  },

  async getOfficeIP() {
    if (redisAvailable === null) {
      await cache.init();
    }
    return await this.get('office_ip');
  },

  async setOfficeIP(ip, ttl = 86400) {
    await this.set('office_ip', ip, ttl);
  },
};

module.exports = cache;

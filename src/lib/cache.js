import { createLogger } from './logger.js';

const log = createLogger('cache');

class LRUCache {
    constructor(maxSize = 100, ttlMs = 60_000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.store = new Map();
    }

    _isExpired(entry) {
        return Date.now() - entry.createdAt > this.ttlMs;
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (this._isExpired(entry)) {
            this.store.delete(key);
            return undefined;
        }
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        if (this.store.has(key)) this.store.delete(key);
        if (this.store.size >= this.maxSize) {
            const oldest = this.store.keys().next().value;
            this.store.delete(oldest);
        }
        this.store.set(key, { value, createdAt: Date.now() });
    }

    invalidate(keyPrefix) {
        let count = 0;
        for (const key of this.store.keys()) {
            if (key.startsWith(keyPrefix)) {
                this.store.delete(key);
                count++;
            }
        }
        return count;
    }

    clear() {
        this.store.clear();
    }

    get size() { return this.store.size; }

    stats() {
        return { size: this.store.size, maxSize: this.maxSize, ttlMs: this.ttlMs };
    }
}

const responseCache = new LRUCache(256, 180_000);
export { LRUCache, responseCache };
export default responseCache;

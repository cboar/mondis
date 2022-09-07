import type { RedisCommander } from 'ioredis';
import type Mondis from '../mondis';
import type CachedQuery from './index';
import type {
  CacheEffect,
  HasObjectId,
} from './types';

type InsertInvalidation =
  | { key: string }
  | { set: string }
  | null;

function union<T>(...targets: (T[] | Set<T>)[]) {
  const result = new Set<T>();
  targets.forEach((target) => {
    target.forEach((val) => result.add(val));
  });
  return Array.from(result);
}

type RedisMultiResult = Awaited<ReturnType<RedisCommander['exec']>>;
function flattenRedisMulti(input: RedisMultiResult) {
  if (!input) return [];
  const result: unknown[] = [];
  input.forEach(([err, val]) => {
    if (err !== null) return;
    result.push(val);
  });
  return result;
}

/**
 * Returns the cache keys that need to be invalidated when an insert effect occurs.
 */
function getInsertInvalidation(
  cq: CachedQuery,
  modelName: string,
  doc: HasObjectId,
): InsertInvalidation {
  const { unique, invalidateOnInsert, model } = cq.config;
  // If this query uniquely identifies a single document,
  // then a new document will have no effect on cached queries.
  if (unique || !invalidateOnInsert || model !== modelName) return null;

  const { matcher, dynamicKeys, complexQuery } = cq.classification;

  const docCouldMatchQuery = matcher(doc);
  // If any field in the document contradicts the query, no need to invalidate
  if (!docCouldMatchQuery) return null;
  // If any configurable part of the query is not just an equality check,
  // we have to invalidate all queries, because we don't know if it has changed.
  if (complexQuery) return { set: cq.getCacheKeyForAll() };
  // Otherwise, just reconstruct the cache key to only invalidate queries with matching params
  const params = dynamicKeys.map((key) => doc[key]);
  return { key: cq.getCacheKey(params) };
}

function parseParamsFromQueryKey(key: string) {
  const result = key.match(/^q:[^[]+(.+?)$/);
  try {
    const match = result && result[1];
    if (match) return JSON.parse(match) as unknown[];
  } catch (err) {
    // logger.warn({ err, tag: 'CACHE_INVALIDATION_ERROR' }, 'Failed to parse JSON');
  }
  return [];
}

export default class InvalidationHandler {
  context: Mondis;

  constructor(context: Mondis) {
    this.context = context;
  }

  // TODO: add queueing mechanism for optimized invalidation batching:
  // remove duplicate keys, set invalidations trump keys
  onCacheEffect(effect: CacheEffect) {
    if (effect.op === 'insert') this.doInsertInvalidation(effect);
    if (effect.op === 'remove') this.doRemoveInvalidation(effect);
  }

  async doInsertInvalidation(effect: CacheEffect & { op: 'insert' }) {
    const { redis } = this.context;
    const { modelName, docs } = effect;

    const { keys, sets } = this.collectInsertInvalidations(modelName, docs);
    const expandedSets = sets.size ? await redis.sunion(...sets) : [];
    await this.invalidate(union(keys, expandedSets));
  }

  async doRemoveInvalidation(effect: CacheEffect & { op: 'remove' }) {
    const { redis } = this.context;
    const { ids } = effect;
    const multi = redis.multi();
    ids.forEach((id) => multi.smembers(`obj:${String(id)}`));
    const result = flattenRedisMulti(await multi.exec()) as string[][];
    if (!result) return;

    const dependentKeys = union(...result);
    await this.invalidate(dependentKeys);
  }

  async invalidate(keys: string[]): Promise<string[]> {
    if (!keys.length) return [];

    const { redis } = this.context;
    const multi = redis.multi();
    keys.forEach((key) => multi.delquery(key));
    const results = await multi.exec();
    if (!results || !results.length) return [];

    const invalidatedKeys: string[] = [];
    results.forEach(([err, didExist], index) => {
      if (err !== null) return;
      const key = keys[index];
      if (key && didExist) invalidatedKeys.push(key);
    });

    return invalidatedKeys;
  }

  async rehydrate(keys: string[]) {
    if (!keys.length) return;

    const promises = keys.map(async (key) => {
      const query = this.findCachedQueryByKey(key);
      if (!query || !query.config.rehydrate) return;

      const params = parseParamsFromQueryKey(key);
      await query.exec({ params, limit: query.config.cacheCount, skipCache: true });
    });

    await Promise.all(promises);
  }

  collectInsertInvalidations(model: string, docs: HasObjectId[]) {
    const keys = new Set<string>();
    const sets = new Set<string>();
    const { allCachedQueries } = this.context;
    allCachedQueries.forEach((query) => {
      docs.forEach((doc) => {
        const info = getInsertInvalidation(query, model, doc);
        if (!info) return;
        if ('key' in info) keys.add(info.key);
        if ('set' in info) sets.add(info.set);
      });
    });
    return { keys, sets };
  }

  findCachedQueryByKey(key: string) {
    const { allCachedQueries } = this.context;
    const match = key.match(/^q:(.*?)\[/);
    if (match && match[1]) {
      const found = allCachedQueries.find((cq) => cq.hash === match[1]);
      if (found) return found;
    }
    return null;
  }
}

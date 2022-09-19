import type Mondis from '../mondis';
import type CachedQuery from './index';
import type { AnyObject, CacheEffect } from './types';
import { PromiseQueue } from './lib';

type InsertInvalidation =
  | { hash: string, all: true }
  | { hash: string, key: string }
  | null;

function union<T>(...targets: (T[] | Set<T>)[]) {
  const result = new Set<T>();
  targets.forEach((target) => {
    target.forEach((val) => result.add(val));
  });
  return Array.from(result);
}

/**
 * Returns the cache keys that need to be invalidated when an insert effect occurs.
 */
function getInsertInvalidation(
  cq: CachedQuery,
  modelName: string,
  doc: AnyObject,
): InsertInvalidation {
  const { unique, invalidateOnInsert, model } = cq.config;
  // If this query uniquely identifies a single document,
  // then a new document will have no effect on cached queries.
  if (unique || !invalidateOnInsert || model !== modelName) return null;

  const { matcher, dynamicKeys, complexQuery } = cq.classification;
  // If any field in the document contradicts the query, no need to invalidate
  const docCouldMatchQuery = matcher(doc);
  if (!docCouldMatchQuery) return null;
  // If any configurable part of the query is not just an equality check,
  // we have to invalidate all queries, because we don't know if it has changed.
  if (complexQuery) return { hash: cq.hash, all: true };
  // Otherwise, just reconstruct the cache key to only invalidate queries with matching params
  const params = dynamicKeys.map((key) => doc[key]);
  return { hash: cq.hash, key: cq.getCacheKey(params) };
}

const MATCH_CACHE_KEY = /^Q:(.+?)(\[.*\])$/;
function parseCacheKey(key: string) {
  const [, hash, params] = key.match(MATCH_CACHE_KEY) || [];
  if (!hash || !params) throw Error('Failed to parse cache key');
  return {
    hash,
    params: JSON.parse(params) as unknown[],
  };
}

export default class InvalidationHandler {
  private promises = new PromiseQueue();

  constructor(
    readonly context: Mondis,
  ) { }

  // TODO: add queueing mechanism for optimized invalidation batching?
  // TODO: implement 'blocking' hash key to prevent edge-case race conditions.
  onCacheEffect(effect: CacheEffect) {
    const { promises } = this;
    if (effect.op === 'insert') {
      promises.add(this.doInsertInvalidation(effect));
    }
    if (effect.op === 'remove') {
      promises.add(this.doRemoveInvalidation(effect));
    }
  }

  private async doInsertInvalidation(effect: CacheEffect & { op: 'insert' }) {
    const { redis } = this.context;
    const { modelName, docs } = effect;

    const { keys, sets } = this.collectInsertInvalidations(modelName, docs);
    const fetchedKeys = (sets.size) ? await redis.sunion(...sets) : [];
    if (!keys.size && !fetchedKeys.length) return; // nothing to do

    await this.invalidate(union(keys, fetchedKeys));
  }

  private async doRemoveInvalidation(effect: CacheEffect & { op: 'remove' }) {
    const { redis } = this.context;
    const { ids } = effect;
    const dependentKeys = await redis.sunion(
      ...ids.map((id) => `O:${String(id)}`),
    );
    if (!dependentKeys.length) return; // nothing to do

    await this.invalidate(dependentKeys);
  }

  private async invalidate(keys: string[]) {
    if (!keys.length) return;

    const { redis } = this.context;
    const multi = redis.multi();
    keys.forEach((key) => multi.delquery(key));
    const results = await multi.exec();
    if (!results || !results.length) return;

    const keysInvalidated: string[] = [];
    results.forEach(([err, didExist], index) => {
      if (err !== null) return;
      const key = keys[index];
      if (key && didExist) keysInvalidated.push(key);
    });

    if (!keysInvalidated.length) return;
    await this.rehydrate(keysInvalidated);
  }

  private async rehydrate(keys: string[]) {
    if (!keys.length) return;

    const { lookupCachedQuery } = this.context;
    const promises = keys.map(async (key) => {
      const { hash, params } = parseCacheKey(key);
      const query = lookupCachedQuery.get(hash);
      if (!query || !query.config.rehydrate) return;
      await query.exec({ params, limit: query.config.cacheCount, skipCache: true });
    });

    await Promise.all(promises);
  }

  private collectInsertInvalidations(model: string, docs: AnyObject[]) {
    const keys = new Set<string>();
    const sets = new Set<string>();
    const hashes = new Set<string>();
    const { lookupCachedQuery } = this.context;
    // eslint-disable-next-line no-restricted-syntax
    for (const query of lookupCachedQuery.values()) {
      docs.forEach((doc) => {
        const info = getInsertInvalidation(query, model, doc);
        if (!info) return;
        hashes.add(info.hash);
        if ('all' in info) sets.add(`A:${info.hash}`);
        if ('key' in info) keys.add(info.key);
      });
    }
    return { keys, sets, hashes };
  }

  finish() {
    return this.promises.flush();
  }
}

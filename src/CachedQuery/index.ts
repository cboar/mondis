import { serialize, deserialize, EJSON } from 'bson';
import type Mondis from '../mondis';
import type {
  HasObjectId,
  QueryFilter,
} from './types';
import type {
  CachedQueryConfig,
} from './config';
import {
  collectPopulatedIds,
  jsonHash,
  skipAndLimit,
} from './utils';

type QueryExecOpts<T> = {
  skip?: number;
  limit?: number | undefined;
  filter?: (doc: T) => boolean;
  skipCache?: boolean;
};

type InputExecOpts<T, P extends unknown[]> =
  | ParsedOptions<T>
  | ([P] extends [never]
    ? (void | QueryExecOpts<T>)
    : (P | QueryExecOpts<T> & { params: P }));

class ParsedOptions<T> {
  constructor(
    readonly query: QueryFilter,
    readonly key: string,
    readonly exec: QueryExecOpts<T>,
  ) { }

  fresh(exec: QueryExecOpts<T>) {
    return new ParsedOptions(this.query, this.key, exec);
  }

  merged(exec: QueryExecOpts<T>) {
    return new ParsedOptions(this.query, this.key, { ...this.exec, ...exec });
  }
}

class CachedQuery<
  T extends HasObjectId = HasObjectId,
  P extends unknown[] = unknown[],
> {
  private _hash?: string;

  constructor(
    readonly context: Mondis,
    readonly config: CachedQueryConfig<T, P>,
  ) { }

  getCacheKey(params: unknown[] = []) {
    const { hash, config: { query } } = this;
    const expectNumParams = (typeof query === 'function') ? query.length : 0;
    if (expectNumParams !== params.length) {
      throw Error(`Invalid number of params passed: expected ${expectNumParams}, got ${params.length}`);
    }
    const paramsStr = EJSON.stringify(params);
    return `Q:${hash}${paramsStr}`;
  }

  private buildQuery(input: InputExecOpts<T, P>) {
    const { mongoose } = this.context;
    const { model, unique, select, sort, populate } = this.config;
    const { query, exec: { skip, limit } } = this.parseOpts(input);
    const q = mongoose.model<T>(model).find(query);
    if (unique) {
      q.limit(1);
    } else {
      if (sort) q.sort(sort);
      if (skip) q.skip(skip);
      if (limit && limit !== Infinity) q.limit(limit);
    }
    if (select) q.select(select);
    if (populate.length) q.populate(populate);
    return q;
  }

  async execMongo(input: InputExecOpts<T, P>) {
    return this.buildQuery(input).lean().exec();
  }

  async countMongo(input: InputExecOpts<T, P>) {
    const full = this.parseOpts(input).merged({ skip: 0, limit: undefined });
    return this.buildQuery(full).countDocuments();
  }

  /**
   * Stringifies the result object and stores it in cache.
   */
  private async serializeAndCache(result: T[], cacheKey: string) {
    const { redis } = this.context;
    const { hash, config: { populate, expiry } } = this;
    try {
      const bson = serialize(result);
      const docIds = result.map((doc) => String(doc._id));
      const populatedIds = collectPopulatedIds(result, populate);
      const allKey = `A:${hash}`;
      // Cache result, and create keys used for tracking invalidations
      const multi = redis.multi();
      multi.del(cacheKey);
      multi.hset(cacheKey, 'V', bson);
      multi.hset(cacheKey, 'O', docIds.join(' '));
      multi.hset(cacheKey, 'P', populatedIds.join(' '));
      multi.sadd(allKey, cacheKey);
      multi.expiregt(cacheKey, expiry);
      multi.expiregt(allKey, expiry);
      docIds.forEach((id) => {
        multi.sadd(`O:${id}`, cacheKey);
        multi.expiregt(`O:${id}`, expiry);
      });
      populatedIds.forEach((id) => {
        multi.sadd(`P:${id}`, cacheKey);
        multi.expiregt(`P:${id}`, expiry);
      });
      await multi.exec();
    } catch (err) {
      // logger.warn({ err, tag: 'CACHE_REDIS_SET', cacheKey, result, }, 'Failed to set value');
    }
  }

  async exec(input: InputExecOpts<T, P>): Promise<T[]> {
    const opts = this.parseOpts(input);
    const { redis } = this.context;
    const { cacheCount, unique } = this.config;
    const { skip = 0, limit, skipCache = false, filter } = opts.exec;
    // query is outside cacheable skip/limit, fall back to mongo query and do not cache.
    // note: filter not handled here because filterable queries require cacheCount=Infinity
    if ((cacheCount < Infinity && limit === undefined) || (limit && (limit + skip) > cacheCount)) {
      return this.execMongo(opts) as Promise<T[]>;
    }
    let result: undefined | T[];
    const { key: cacheKey } = opts;
    if (!skipCache) {
      try {
        const bson = await redis.hgetBuffer(cacheKey, 'V');
        if (bson !== null) {
          result = Object.values(deserialize(bson)) as T[];
        }
      } catch (err) {
        // logger.warn({ err, tag: 'CACHE_REDIS_GET', cacheKey }, 'Failed to HGET value');
      }
    }
    if (!result) {
      result = await this.execMongo(opts.fresh({ limit: cacheCount })) as T[];
      /* If a unique query has no results, do not cache the empty array.
       * The matching item could still be inserted at a later time, and because
       * unique queries do not invalidate upon document insert, that event
       * would not be detected for invalidation. */
      if (result.length > 0 || !unique) {
        this.serializeAndCache(result, cacheKey);
      }
    }
    if (filter) result = result.filter(filter);
    return skipAndLimit(result, skip, limit);
  }

  async execOne(input: InputExecOpts<T, P>): Promise<T | null> {
    const limitOne = this.parseOpts(input).merged({ limit: 1 });
    const result = await this.exec(limitOne);
    return result[0] ?? null;
  }

  async execWithCount(input: InputExecOpts<T, P>): Promise<[T[], number]> {
    const opts = this.parseOpts(input);
    const { cacheCount } = this.config;
    /* If cacheCount is infinity, we know all the documents matching the query
     * are already stored on cache. We already have to grab and splice it,
     * so we might as well use the array length instead of another lookup.
     */
    if (cacheCount === Infinity) {
      const { skip, limit } = opts.exec;
      // note: if applicable, the filter func is already applied to fullResult.
      const fullResult = await this.exec(opts.merged({ skip: 0, limit: undefined }));
      const result = skipAndLimit(fullResult, skip, limit);
      return [
        result,
        fullResult.length,
      ];
    }
    return Promise.all([
      this.exec(opts),
      this.count(opts),
    ]);
  }

  async count(input: InputExecOpts<T, P>) {
    const opts = this.parseOpts(input);
    const { redis } = this.context;
    const { key: cacheKey, exec: { filter, skipCache = false } } = opts;
    if (filter) {
      const fullResult = await this.exec(opts.merged({ skip: 0, limit: undefined }));
      return fullResult.length;
    }
    let count;
    if (!skipCache) {
      try {
        count = await redis.hget(cacheKey, 'count');
      } catch (err) {
        // logger.warn({ err, tag: 'CACHE_REDIS_GET', cacheKey }, 'Failed to HGET value');
      }
    }
    if (!count) {
      count = await this.countMongo(opts.fresh({}));
      try {
        await redis.hset(cacheKey, 'count', count);
      } catch (err) {
        // logger.warn({ err, tag: 'CACHE_REDIS_SET', cacheKey }, 'Failed to set value');
      }
    }
    return typeof count === 'number' ? count : parseInt(count, 10);
  }

  private parseOpts(input: InputExecOpts<T, P>) {
    if (input instanceof ParsedOptions) return input;
    const { query } = this.config;
    const exec: QueryExecOpts<T> = (!input || Array.isArray(input)) ? {} : input;
    if (typeof query === 'function') {
      const params = Array.isArray(input) ? (input as P) : (input as { params: P }).params;
      return new ParsedOptions(query(...params), this.getCacheKey(params), exec);
    }
    return new ParsedOptions(query, this.getCacheKey([]), exec);
  }

  /* Generates a hash of the config object used to create this CachedQuery.
   * Used in the redis key name. This is useful for versioning queries, as
   * updated queries will not clash with the old ones, which will simply expire away.
   */
  get hash() {
    if (!this._hash) {
      const { query } = this.config;
      if (typeof query === 'object') {
        this._hash = jsonHash(this.config);
      } else {
        const params = Array(query.length).fill(null).map((_v, i) => `$CQP${i}$`) as P;
        this._hash = jsonHash({ ...this.config, query: query(...params) });
      }
    }
    return this._hash;
  }
}

export default CachedQuery;

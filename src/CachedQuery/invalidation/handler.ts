import type Mondis from '../../mondis';
import {
  buildInvalidationMaps,
  type InvalidationMaps,
} from './core';
import type { CacheEffect } from '../types';
import { union } from '../utils';

export default class InvalidationHandler {
  private _invalidationMaps?: InvalidationMaps;
  readonly keysInvalidated = new Set<string>();

  constructor(
    readonly context: Mondis,
  ) { }

  onCacheEffect(effect: CacheEffect) {
    switch (effect.op) {
      case 'insert': return this.doInsertInvalidation(effect);
      case 'update': return this.doUpdateInvalidation(effect);
      case 'remove': return this.doRemoveInvalidation(effect);
      default: return null;
    }
  }

  private async doUpdateInvalidation(effect: CacheEffect & { op: 'update' }) {
    // TODO
  }

  private async doInsertInvalidation(effect: CacheEffect & { op: 'insert' }) {
    // TODO
  }

  private async doRemoveInvalidation(effect: CacheEffect & { op: 'remove' }) {
    const { redis } = this.context;
    const { ids } = effect;
    const dependentKeys = await redis.sunion(
      ...ids.map((id) => `O:${String(id)}`),
      ...ids.map((id) => `P:${String(id)}`),
    );
    if (!dependentKeys.length) return; // nothing to do
    await this.invalidate(dependentKeys);
  }

  async invalidate(keys: string[]) {
    if (!keys.length) return;

    const { redis } = this.context;
    const multi = redis.multi();
    keys.forEach((key) => multi.delquery(key));
    const results = await multi.exec();
    if (!results || !results.length) return;

    const { keysInvalidated } = this;
    results.forEach(([err, didExist], index) => {
      if (err !== null) return;
      const key = keys[index];
      if (key && didExist) keysInvalidated.add(key);
    });
  }

  // private async fetchInvalidations<D, E extends CacheEffect & { docs: D[] }>(
  //   effect: E,
  //   cb: (cq: CachedQuery, effect: E, doc: D) => KeyInvalidation | null,
  // ): Promise<string[]> {
  //   const { lookupCachedQuery, redis } = this.context;
  //   const { docs } = effect;
  //   const keys = new Set<string>();
  //   const sets = new Set<string>();
  //   for (const query of lookupCachedQuery.values()) {
  //     docs.forEach((doc) => {
  //       const info = cb(query, doc, effect);
  //       // const info = getUpdateInvalidation(query, modelName, modified, before, after);
  //       if (!info) return;
  //       if ('all' in info) sets.add(`A:${info.hash}`);
  //       if ('keys' in info) info.keys.forEach((key) => keys.add(key));
  //     });
  //   }
  //   const fetchedKeys = (sets.size) ? await redis.sunion(...sets) : [];
  //   return union(keys, fetchedKeys);
  // }

  private collectInvalidations(model: string) {
    const { invalidationMaps } = this;
    const keys = new Set<string>();
    const sets = new Set<string>();
    invalidationMaps.primary.get(model)?.forEach(() => {
    });
  }

  get invalidationMaps() {
    if (!this._invalidationMaps) {
      const queries = Object.values(this.context.queries);
      this._invalidationMaps = buildInvalidationMaps(queries);
    }
    return this._invalidationMaps;
  }
}

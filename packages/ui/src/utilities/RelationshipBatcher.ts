/**
 * Relationship Data Batching Utility
 *
 * Solves N+1 query problem described in issue #13329:
 * - Arrays with 50 items × 2 relationships = 100+ API requests
 * - Causes MongoDB connection exhaustion on Vercel (500 limit)
 * - Results in UI crashes and poor performance
 *
 * Solution:
 * 1. Batch relationship IDs by collection type
 * 2. Cache fetched relationship data with TTL and locale-aware keys
 * 3. Limit concurrent requests to prevent connection pool exhaustion
 * 4. Deduplicate IDs to avoid redundant requests
 */

import type { PaginatedDocs, SanitizedCollectionConfig } from 'payload'

import { formatAdminURL } from 'payload/shared'
import * as qs from 'qs-esm'

// Configuration constants
const DEFAULT_MAX_CONCURRENT_REQUESTS = 10
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_CACHE_SIZE = 1000 // Prevent unbounded memory growth

interface RelationshipCacheEntry {
  data: unknown
  timestamp: number
  ttl: number
}

interface BatchedRelationshipRequest {
  collection: SanitizedCollectionConfig
  ids: string[]
  fieldToSelect: string
}

interface RelationshipBatcherConfig {
  apiRoute: string
  locale: string
  i18nLanguage: string
  maxConcurrentRequests?: number
  cacheTTL?: number // Time to live in milliseconds
}

export class RelationshipBatcher {
  private cache: Map<string, RelationshipCacheEntry>
  private pendingRequests: Map<string, Promise<unknown>>
  private activeRequests: number
  private requestQueue: Array<() => void>

  private readonly apiRoute: string
  private readonly locale: string
  private readonly i18nLanguage: string
  private readonly maxConcurrentRequests: number
  private readonly cacheTTL: number

  constructor(config: RelationshipBatcherConfig) {
    this.cache = new Map()
    this.pendingRequests = new Map()
    this.activeRequests = 0
    this.requestQueue = []

    this.apiRoute = config.apiRoute
    this.locale = config.locale
    this.i18nLanguage = config.i18nLanguage
    this.maxConcurrentRequests = config.maxConcurrentRequests || DEFAULT_MAX_CONCURRENT_REQUESTS
    this.cacheTTL = config.cacheTTL || DEFAULT_CACHE_TTL_MS
  }

  /**
   * Generate a locale-aware cache key for a relationship.
   * Including locale prevents stale localized `useAsTitle` values from being served
   * when the admin session changes locale.
   */
  private getCacheKey(collection: string, id: string): string {
    return `${collection}:${this.locale}:${id}`
  }

  /**
   * Check if cache entry is valid (not expired)
   */
  private isCacheValid(entry: RelationshipCacheEntry): boolean {
    return Date.now() - entry.timestamp < entry.ttl
  }

  /**
   * Get cached data if available and not expired
   */
  getFromCache(collection: string, id: string): unknown | null {
    const cacheKey = this.getCacheKey(collection, id)
    const entry = this.cache.get(cacheKey)

    if (entry && this.isCacheValid(entry)) {
      return entry.data
    }

    // Remove expired entry
    if (entry) {
      this.cache.delete(cacheKey)
    }

    return null
  }

  /**
   * Set cache entry with timestamp.
   * Implements FIFO eviction when cache exceeds MAX_CACHE_SIZE — entries are
   * evicted in insertion order. `id` is always normalised to a string so that
   * numeric IDs (e.g. from Postgres collections) produce consistent cache keys.
   */
  setCache(collection: string, id: string, data: unknown): void {
    const normalizedId = String(id)
    const cacheKey = this.getCacheKey(collection, normalizedId)

    // Evict oldest-inserted entry if cache is full (FIFO strategy)
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      ttl: this.cacheTTL,
    })
  }

  /**
   * Execute request with concurrency control
   */
  private async executeWithConcurrencyControl<T>(requestFn: () => Promise<T>): Promise<T> {
    // Wait if we're at max concurrency
    if (this.activeRequests >= this.maxConcurrentRequests) {
      await new Promise<void>((resolve) => {
        this.requestQueue.push(resolve)
      })
    }

    this.activeRequests++

    try {
      return await requestFn()
    } finally {
      this.activeRequests--

      // Process next queued request
      const next = this.requestQueue.shift()
      if (next) {
        next()
      }
    }
  }

  /**
   * Fetch relationships for a single collection with batching.
   * If a pending request for the same batch key already exists, awaits it and
   * returns the now-cached results immediately — avoiding duplicate network calls.
   */
  async fetchBatch(request: BatchedRelationshipRequest): Promise<Array<unknown | null>> {
    const { collection, ids, fieldToSelect } = request

    // Filter out IDs that are already cached
    const idsToFetch = ids.filter((id) => this.getFromCache(collection.slug, id) === null)

    // If all IDs are cached, return cached data without any network request
    if (idsToFetch.length === 0) {
      return ids.map((id) => this.getFromCache(collection.slug, id))
    }

    // Check if there's already a pending request for this exact batch
    const batchKey = `${collection.slug}:${fieldToSelect}:${[...idsToFetch].sort().join(',')}`
    const pendingRequest = this.pendingRequests.get(batchKey)

    if (pendingRequest) {
      // Await the in-flight request and return cached results — do NOT create a
      // second request for the same batch key (that would defeat the deduplication).
      await pendingRequest
      return ids.map((id) => this.getFromCache(collection.slug, id))
    }

    // Create new batched request
    const requestPromise = this.executeWithConcurrencyControl(async () => {
      const query = {
        depth: 0,
        draft: true,
        limit: idsToFetch.length,
        locale: this.locale,
        select: {
          id: true, // Always select id so cache lookups by doc.id are reliable
          [fieldToSelect]: true,
        },
        where: {
          id: {
            in: idsToFetch,
          },
        },
      }

      const response = await fetch(
        formatAdminURL({
          apiRoute: this.apiRoute,
          path: `/${collection.slug}`,
        }),
        {
          body: qs.stringify(query),
          credentials: 'include',
          headers: {
            'Accept-Language': this.i18nLanguage,
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Payload-HTTP-Method-Override': 'GET',
          },
          method: 'POST',
        },
      )

      if (!response.ok) {
        throw new Error(`Failed to fetch ${collection.slug}: ${response.status}`)
      }

      const data: PaginatedDocs<Record<string, unknown>> = await response.json()

      // Cache each document; normalise id to string for consistent key generation
      data.docs.forEach((doc) => {
        if (doc.id !== undefined && doc.id !== null) {
          this.setCache(collection.slug, String(doc.id), doc)
        }
      })

      return data.docs
    })

    this.pendingRequests.set(batchKey, requestPromise)

    try {
      await requestPromise
    } finally {
      this.pendingRequests.delete(batchKey)
    }

    // Return combined results (cached + fetched)
    return ids.map((id) => this.getFromCache(collection.slug, id))
  }

  /**
   * Batch and fetch multiple relationship types efficiently.
   *
   * Groups relationships by a composite key of `collection.slug` and
   * `fieldToSelect` so that callers requesting different fields for the same
   * collection each receive the correct data. Requests are executed in parallel
   * within the configured concurrency limit.
   *
   * @param relationships - Array of { collection, id, fieldToSelect }
   * @returns Map of collection slug to fetched documents
   *
   * @example
   * ```typescript
   * const batcher = getGlobalRelationshipBatcher(config)
   * const results = await batcher.batchFetch([
   *   { collection: categoriesConfig, id: 'cat-1', fieldToSelect: 'title' },
   *   { collection: categoriesConfig, id: 'cat-2', fieldToSelect: 'title' },
   *   { collection: partnersConfig, id: 'partner-1', fieldToSelect: 'name' },
   * ])
   * // Makes only 2 requests instead of 3 (batched by collection + fieldToSelect)
   * ```
   *
   * @throws {Error} If fetch request fails with non-OK status
   */
  async batchFetch(
    relationships: Array<{
      collection: SanitizedCollectionConfig
      id: string
      fieldToSelect: string
    }>,
  ): Promise<Map<string, unknown[]>> {
    // Group by composite key (slug + fieldToSelect) to avoid dropping different
    // field selections for the same collection within a single batch.
    const grouped = relationships.reduce(
      (acc, rel) => {
        const key = `${rel.collection.slug}:${rel.fieldToSelect}`
        const existing = acc.get(key)
        if (!existing) {
          acc.set(key, {
            collection: rel.collection,
            ids: [rel.id],
            fieldToSelect: rel.fieldToSelect,
          })
        } else {
          existing.ids.push(rel.id)
        }
        return acc
      },
      new Map<string, BatchedRelationshipRequest>(),
    )

    // Deduplicate IDs within each group
    grouped.forEach((request) => {
      request.ids = Array.from(new Set(request.ids))
    })

    // Fetch all batches in parallel (within concurrency limits)
    const fetchPromises = Array.from(grouped.values()).map((request) =>
      this.fetchBatch(request),
    )

    await Promise.all(fetchPromises)

    // Return results organised by collection slug
    const results = new Map<string, unknown[]>()
    grouped.forEach((request, _groupKey) => {
      const collectionSlug = request.collection.slug
      const docs = request.ids
        .map((id) => this.getFromCache(collectionSlug, id))
        .filter((doc): doc is unknown => doc !== null)

      // Merge into existing entry when multiple fieldToSelect groups share a slug
      const existing = results.get(collectionSlug)
      if (existing) {
        existing.push(...docs)
      } else {
        results.set(collectionSlug, docs)
      }
    })

    return results
  }

  /**
   * Clear cache (useful for manual invalidation)
   */
  clearCache(collectionSlug?: string): void {
    if (collectionSlug) {
      // Clear specific collection (all locales)
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${collectionSlug}:`)) {
          this.cache.delete(key)
        }
      }
    } else {
      // Clear all
      this.cache.clear()
    }
  }

  /**
   * Get cache statistics (useful for debugging)
   */
  getStats(): {
    size: number
    activeRequests: number
    queuedRequests: number
  } {
    return {
      size: this.cache.size,
      activeRequests: this.activeRequests,
      queuedRequests: this.requestQueue.length,
    }
  }
}

/**
 * Singleton instance for global relationship batching.
 * Initialized on first use. Re-initialized automatically when `apiRoute`,
 * `locale`, or `i18nLanguage` change so that locale-specific data is never
 * served stale from a previous session configuration.
 */
let globalBatcher: RelationshipBatcher | null = null

export function getGlobalRelationshipBatcher(
  config?: RelationshipBatcherConfig,
): RelationshipBatcher {
  if (config) {
    // Re-initialize if any context value has changed (locale, language, api)
    if (
      !globalBatcher ||
      globalBatcher['locale'] !== config.locale ||
      globalBatcher['i18nLanguage'] !== config.i18nLanguage ||
      globalBatcher['apiRoute'] !== config.apiRoute
    ) {
      globalBatcher = new RelationshipBatcher(config)
    }
  }

  if (!globalBatcher) {
    throw new Error(
      'RelationshipBatcher not initialized. Call getGlobalRelationshipBatcher with config first.',
    )
  }

  return globalBatcher
}

export function resetGlobalRelationshipBatcher(): void {
  globalBatcher = null
}

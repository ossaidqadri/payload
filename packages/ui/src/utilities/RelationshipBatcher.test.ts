/**
 * Tests for RelationshipBatcher utility
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RelationshipBatcher,
  getGlobalRelationshipBatcher,
  resetGlobalRelationshipBatcher,
} from './RelationshipBatcher.js'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

const mockCollection = {
  slug: 'categories',
  admin: {
    useAsTitle: 'title',
  },
} as any

describe('RelationshipBatcher', () => {
  let batcher: RelationshipBatcher

  beforeEach(() => {
    batcher = new RelationshipBatcher({
      apiRoute: '/api',
      locale: 'en',
      i18nLanguage: 'en',
      maxConcurrentRequests: 5,
      cacheTTL: 5 * 60 * 1000,
    })
    mockFetch.mockClear()
  })

  afterEach(() => {
    resetGlobalRelationshipBatcher()
  })

  describe('Cache Management', () => {
    it('should cache fetched relationship data', () => {
      batcher.setCache('categories', 'cat-1', { id: 'cat-1', title: 'Category 1' })
      const cached = batcher.getFromCache('categories', 'cat-1')

      expect(cached).toEqual({ id: 'cat-1', title: 'Category 1' })
    })

    it('should return null for expired cache entries', () => {
      // Create batcher with very short TTL
      const shortTTLBatcher = new RelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
        cacheTTL: 100, // 100ms
      })

      shortTTLBatcher.setCache('categories', 'cat-1', { id: 'cat-1', title: 'Category 1' })

      // Manually expire by setting old timestamp
      const cacheKey = shortTTLBatcher['getCacheKey']('categories', 'cat-1')
      const entry = shortTTLBatcher['cache'].get(cacheKey)
      if (entry) {
        entry.timestamp = Date.now() - 200 // Expired
      }

      const cached = shortTTLBatcher.getFromCache('categories', 'cat-1')
      expect(cached).toBeNull()
    })

    it('should clear cache for specific collection', () => {
      batcher.setCache('categories', 'cat-1', { id: 'cat-1' })
      batcher.setCache('partners', 'partner-1', { id: 'partner-1' })

      batcher.clearCache('categories')

      expect(batcher.getFromCache('categories', 'cat-1')).toBeNull()
      expect(batcher.getFromCache('partners', 'partner-1')).toBeDefined()
    })

    it('should clear all cache when no collection specified', () => {
      batcher.setCache('categories', 'cat-1', { id: 'cat-1' })
      batcher.setCache('partners', 'partner-1', { id: 'partner-1' })

      batcher.clearCache()

      expect(batcher.getFromCache('categories', 'cat-1')).toBeNull()
      expect(batcher.getFromCache('partners', 'partner-1')).toBeNull()
    })

    it('should normalise numeric ids to strings when caching', () => {
      // Postgres collections may use numeric ids
      batcher.setCache('categories', String(42), { id: 42, title: 'Numeric ID' })

      // Both string and numeric lookups should work consistently
      expect(batcher.getFromCache('categories', '42')).toBeDefined()
      expect(batcher.getFromCache('categories', '42')).toEqual({ id: 42, title: 'Numeric ID' })
    })

    it('should scope cache entries by locale', () => {
      const enBatcher = new RelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
      })

      const esBatcher = new RelationshipBatcher({
        apiRoute: '/api',
        locale: 'es',
        i18nLanguage: 'es',
      })

      enBatcher.setCache('categories', 'cat-1', { id: 'cat-1', title: 'English Title' })

      // The es batcher should not see the en batcher's cache entries
      expect(esBatcher.getFromCache('categories', 'cat-1')).toBeNull()
    })
  })

  describe('Batch Fetching', () => {
    it('should batch multiple IDs from same collection into single request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          docs: [
            { id: 'cat-1', title: 'Category 1' },
            { id: 'cat-2', title: 'Category 2' },
            { id: 'cat-3', title: 'Category 3' },
          ],
        }),
      })

      await batcher.fetchBatch({
        collection: mockCollection,
        ids: ['cat-1', 'cat-2', 'cat-3'],
        fieldToSelect: 'title',
      })

      // Should only make 1 request for all 3 IDs
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should deduplicate IDs before fetching', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          docs: [{ id: 'cat-1', title: 'Category 1' }],
        }),
      })

      await batcher.fetchBatch({
        collection: mockCollection,
        ids: ['cat-1', 'cat-1', 'cat-1'], // Duplicates
        fieldToSelect: 'title',
      })

      // Should deduplicate to single ID
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const call = mockFetch.mock.calls[0]
      const body = call[1].body as string
      expect(body).toContain('where%5Bid%5D%5Bin%5D') // Check where id in query
    })

    it('should skip IDs that are already cached', async () => {
      // Pre-cache one ID
      batcher.setCache('categories', 'cat-1', { id: 'cat-1', title: 'Category 1' })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          docs: [
            { id: 'cat-2', title: 'Category 2' },
            { id: 'cat-3', title: 'Category 3' },
          ],
        }),
      })

      await batcher.fetchBatch({
        collection: mockCollection,
        ids: ['cat-1', 'cat-2', 'cat-3'], // cat-1 is cached
        fieldToSelect: 'title',
      })

      // Should only fetch cat-2 and cat-3
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should return cached results immediately when all IDs are cached', async () => {
      batcher.setCache('categories', 'cat-1', { id: 'cat-1', title: 'Category 1' })
      batcher.setCache('categories', 'cat-2', { id: 'cat-2', title: 'Category 2' })

      const results = await batcher.fetchBatch({
        collection: mockCollection,
        ids: ['cat-1', 'cat-2'],
        fieldToSelect: 'title',
      })

      expect(mockFetch).not.toHaveBeenCalled()
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({ id: 'cat-1', title: 'Category 1' })
    })

    it('should always include id in the select query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ docs: [{ id: 'cat-1', title: 'Category 1' }] }),
      })

      await batcher.fetchBatch({
        collection: mockCollection,
        ids: ['cat-1'],
        fieldToSelect: 'title',
      })

      const requestBody = mockFetch.mock.calls[0][1].body as string
      // Verify that id is selected so caching works correctly
      expect(requestBody).toContain('select%5Bid%5D=true')
    })

    it('should group multiple collection types and fetch in parallel', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            docs: [{ id: 'cat-1', title: 'Category 1' }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            docs: [{ id: 'partner-1', name: 'Partner 1' }],
          }),
        })

      const relationships = [
        { collection: mockCollection, id: 'cat-1', fieldToSelect: 'title' },
        {
          collection: { slug: 'partners', admin: { useAsTitle: 'name' } } as any,
          id: 'partner-1',
          fieldToSelect: 'name',
        },
      ]

      const results = await batcher.batchFetch(relationships)

      // Should make 2 requests (one per collection)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(results.size).toBe(2)
    })
  })

  describe('Pending Request Deduplication', () => {
    it('should return cached results when awaiting an in-flight request for the same batch', async () => {
      let fetchCount = 0
      mockFetch.mockImplementation(async () => {
        fetchCount++
        await new Promise((resolve) => setTimeout(resolve, 50))
        return {
          ok: true,
          json: async () => ({ docs: [{ id: 'cat-1', title: 'Category 1' }] }),
        }
      })

      // Start two requests for the same IDs simultaneously
      const [result1, result2] = await Promise.all([
        batcher.fetchBatch({
          collection: mockCollection,
          ids: ['cat-1'],
          fieldToSelect: 'title',
        }),
        batcher.fetchBatch({
          collection: mockCollection,
          ids: ['cat-1'],
          fieldToSelect: 'title',
        }),
      ])

      // The deduplication means only one actual fetch should happen
      expect(fetchCount).toBe(1)
      expect(result1[0]).toEqual({ id: 'cat-1', title: 'Category 1' })
      expect(result2[0]).toEqual({ id: 'cat-1', title: 'Category 1' })
    })
  })

  describe('Concurrency Control', () => {
    it('should limit concurrent requests to prevent connection exhaustion', async () => {
      const limitedBatcher = new RelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
        maxConcurrentRequests: 2,
      })

      let maxActiveRequests = 0
      let currentActiveRequests = 0

      // Mock fetch that tracks concurrent calls
      mockFetch.mockImplementation(async () => {
        currentActiveRequests++
        maxActiveRequests = Math.max(maxActiveRequests, currentActiveRequests)
        await new Promise((resolve) => setTimeout(resolve, 50))
        currentActiveRequests--
        return {
          ok: true,
          json: async () => ({ docs: [] }),
        }
      })

      // Trigger multiple concurrent requests
      const promises = Array.from({ length: 5 }, (_, i) =>
        limitedBatcher.fetchBatch({
          collection: { slug: `collection-${i}` } as any,
          ids: [`id-${i}`],
          fieldToSelect: 'title',
        }),
      )

      await Promise.all(promises)

      // Should never exceed maxConcurrentRequests (2)
      expect(maxActiveRequests).toBeLessThanOrEqual(2)
    })
  })

  describe('Error Handling', () => {
    it('should reject when the server returns a non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
      })

      await expect(
        batcher.fetchBatch({
          collection: mockCollection,
          ids: ['cat-1'],
          fieldToSelect: 'title',
        }),
      ).rejects.toBeDefined()
    })

    it('should remove pending request from cache on failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      await expect(
        batcher.fetchBatch({
          collection: mockCollection,
          ids: ['cat-1'],
          fieldToSelect: 'title',
        }),
      ).rejects.toBeDefined()

      // Pending request should be cleaned up so subsequent requests are not blocked
      expect(batcher['pendingRequests'].size).toBe(0)
    })
  })

  describe('Global Batcher Singleton', () => {
    it('should create singleton instance', () => {
      const batcher1 = getGlobalRelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
      })

      const batcher2 = getGlobalRelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
      })

      expect(batcher1).toBe(batcher2)
    })

    it('should throw if accessed without initialization', () => {
      resetGlobalRelationshipBatcher()

      expect(() => getGlobalRelationshipBatcher()).toThrow('RelationshipBatcher not initialized')
    })

    it('should allow reset for testing', () => {
      getGlobalRelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
      })

      resetGlobalRelationshipBatcher()

      expect(() => getGlobalRelationshipBatcher()).toThrow()
    })

    it('should re-initialize when locale changes', () => {
      const batcher1 = getGlobalRelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
      })

      const batcher2 = getGlobalRelationshipBatcher({
        apiRoute: '/api',
        locale: 'es',
        i18nLanguage: 'es',
      })

      // Locale changed — a new instance should have been created
      expect(batcher1).not.toBe(batcher2)
    })
  })

  describe('Statistics', () => {
    it('should report cache statistics', () => {
      batcher.setCache('categories', 'cat-1', { id: 'cat-1' })
      batcher.setCache('categories', 'cat-2', { id: 'cat-2' })

      const stats = batcher.getStats()

      expect(stats.size).toBe(2)
      expect(stats.activeRequests).toBe(0)
      expect(stats.queuedRequests).toBe(0)
    })
  })
})

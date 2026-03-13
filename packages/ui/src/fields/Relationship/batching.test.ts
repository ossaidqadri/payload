/**
 * Tests for relationship field batching optimization
 *
 * Issue: https://github.com/payloadcms/payload/issues/13329
 *
 * Problem: Array fields with relationships cause N+1 API requests
 * - 50 array items × 2 relationships = 100+ REST API calls
 * - Causes MongoDB connection exhaustion on Vercel (500 limit)
 * - Results in UI crashes and poor performance
 *
 * Expected behavior after fix:
 * - Relationships should be batched by collection type
 * - Multiple items with same relationship type should use single request
 * - Implement caching to prevent duplicate requests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RelationshipBatcher,
  getGlobalRelationshipBatcher,
  resetGlobalRelationshipBatcher,
} from '../../utilities/RelationshipBatcher.js'
import { buildRelationshipsToFetch } from './utils.js'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof global.fetch

const mockCategoriesCollection = {
  slug: 'categories',
  admin: { useAsTitle: 'title' },
} as unknown as import('payload').SanitizedCollectionConfig

const mockPartnersCollection = {
  slug: 'partners',
  admin: { useAsTitle: 'name' },
} as unknown as import('payload').SanitizedCollectionConfig

describe('Relationship Field Batching — Real Implementation', () => {
  let batcher: RelationshipBatcher

  beforeEach(() => {
    resetGlobalRelationshipBatcher()
    mockFetch.mockClear()
    batcher = new RelationshipBatcher({
      apiRoute: '/api',
      locale: 'en',
      i18nLanguage: 'en',
    })
  })

  afterEach(() => {
    resetGlobalRelationshipBatcher()
  })

  describe('buildRelationshipsToFetch', () => {
    it('should filter out items already in component options', () => {
      const options = [
        {
          options: [{ value: 'cat-1', relationTo: 'categories' }],
        },
      ]

      const result = buildRelationshipsToFetch({
        relationMap: { categories: ['cat-1', 'cat-2'] },
        getEntityConfig: () => mockCategoriesCollection as any,
        options,
        batcher,
      })

      // cat-1 is already in options; only cat-2 should be fetched
      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe('cat-2')
    })

    it('should filter out items already in the batcher cache', () => {
      batcher.setCache('categories', 'cat-1', { id: 'cat-1', title: 'Cached' })

      const result = buildRelationshipsToFetch({
        relationMap: { categories: ['cat-1', 'cat-2'] },
        getEntityConfig: () => mockCategoriesCollection as any,
        options: [],
        batcher,
      })

      // cat-1 is in batcher cache; only cat-2 should be fetched
      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe('cat-2')
    })

    it('should skip relations whose collection config cannot be resolved', () => {
      const result = buildRelationshipsToFetch({
        relationMap: { 'unknown-collection': ['id-1'] },
        getEntityConfig: () => undefined, // Config not found
        options: [],
        batcher,
      })

      expect(result).toHaveLength(0)
    })

    it('should correctly group IDs across multiple collections', () => {
      const getEntityConfig = ({ collectionSlug }: { collectionSlug: string }) => {
        if (collectionSlug === 'categories') return mockCategoriesCollection as any
        if (collectionSlug === 'partners') return mockPartnersCollection as any
        return undefined
      }

      const result = buildRelationshipsToFetch({
        relationMap: {
          categories: ['cat-1', 'cat-2'],
          partners: ['partner-1'],
        },
        getEntityConfig,
        options: [],
        batcher,
      })

      expect(result).toHaveLength(3)
      const categoriesItems = result.filter((r) => r.collection.slug === 'categories')
      const partnersItems = result.filter((r) => r.collection.slug === 'partners')
      expect(categoriesItems).toHaveLength(2)
      expect(partnersItems).toHaveLength(1)
    })
  })

  describe('batchFetch — request batching', () => {
    it('should make a single request for multiple IDs in the same collection', async () => {
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

      await batcher.batchFetch([
        { collection: mockCategoriesCollection, id: 'cat-1', fieldToSelect: 'title' },
        { collection: mockCategoriesCollection, id: 'cat-2', fieldToSelect: 'title' },
        { collection: mockCategoriesCollection, id: 'cat-3', fieldToSelect: 'title' },
      ])

      // 50 items with same collection → 1 request (not 50)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should make one request per collection type', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ docs: [{ id: 'cat-1', title: 'C1' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ docs: [{ id: 'partner-1', name: 'P1' }] }),
        })

      await batcher.batchFetch([
        { collection: mockCategoriesCollection, id: 'cat-1', fieldToSelect: 'title' },
        { collection: mockPartnersCollection, id: 'partner-1', fieldToSelect: 'name' },
      ])

      // 2 collection types → 2 requests (not n × m)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should cache all fetched docs so subsequent fetches skip the network', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          docs: [
            { id: 'cat-1', title: 'Category 1' },
            { id: 'cat-2', title: 'Category 2' },
          ],
        }),
      })

      // First fetch
      await batcher.batchFetch([
        { collection: mockCategoriesCollection, id: 'cat-1', fieldToSelect: 'title' },
        { collection: mockCategoriesCollection, id: 'cat-2', fieldToSelect: 'title' },
      ])

      expect(mockFetch).toHaveBeenCalledTimes(1)
      mockFetch.mockClear()

      // Second fetch — all items should be served from cache
      await batcher.batchFetch([
        { collection: mockCategoriesCollection, id: 'cat-1', fieldToSelect: 'title' },
        { collection: mockCategoriesCollection, id: 'cat-2', fieldToSelect: 'title' },
      ])

      expect(mockFetch).toHaveBeenCalledTimes(0)

      // Verify the data is accessible
      expect(batcher.getFromCache('categories', 'cat-1')).toEqual({
        id: 'cat-1',
        title: 'Category 1',
      })
      expect(batcher.getFromCache('categories', 'cat-2')).toEqual({
        id: 'cat-2',
        title: 'Category 2',
      })
    })

    it('should deduplicate IDs within a batch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ docs: [{ id: 'cat-1', title: 'Category 1' }] }),
      })

      await batcher.batchFetch([
        { collection: mockCategoriesCollection, id: 'cat-1', fieldToSelect: 'title' },
        { collection: mockCategoriesCollection, id: 'cat-1', fieldToSelect: 'title' }, // duplicate
      ])

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('Concurrency Control', () => {
    it('should not exceed maxConcurrentRequests simultaneous network calls', async () => {
      const maxConcurrent = 2
      const limitedBatcher = new RelationshipBatcher({
        apiRoute: '/api',
        locale: 'en',
        i18nLanguage: 'en',
        maxConcurrentRequests: maxConcurrent,
      })

      let activeFetches = 0
      let peakFetches = 0

      mockFetch.mockImplementation(async () => {
        activeFetches++
        peakFetches = Math.max(peakFetches, activeFetches)
        await new Promise((resolve) => setTimeout(resolve, 20))
        activeFetches--
        return { ok: true, json: async () => ({ docs: [] }) }
      })

      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          limitedBatcher.fetchBatch({
            collection: { slug: `col-${i}` } as any,
            ids: [`id-${i}`],
            fieldToSelect: 'title',
          }),
        ),
      )

      expect(peakFetches).toBeLessThanOrEqual(maxConcurrent)
      // Vercel MongoDB limit is 500; our concurrency limit protects against this
      expect(maxConcurrent).toBeLessThan(500)
    })
  })

  describe('Error Handling', () => {
    it('should reject with an error when the API returns a non-OK status', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })

      await expect(
        batcher.fetchBatch({
          collection: mockCategoriesCollection,
          ids: ['cat-1'],
          fieldToSelect: 'title',
        }),
      ).rejects.toThrow('403')
    })

    it('should clean up pending request state after a network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      await expect(
        batcher.fetchBatch({
          collection: mockCategoriesCollection,
          ids: ['cat-1'],
          fieldToSelect: 'title',
        }),
      ).rejects.toBeDefined()

      expect(batcher['pendingRequests'].size).toBe(0)
    })
  })
})

describe('RelationshipBatcher Singleton', () => {
  afterEach(() => {
    resetGlobalRelationshipBatcher()
  })

  it('should return the same instance for identical config', () => {
    const config = { apiRoute: '/api', locale: 'en', i18nLanguage: 'en' }
    const b1 = getGlobalRelationshipBatcher(config)
    const b2 = getGlobalRelationshipBatcher(config)

    expect(b1).toBe(b2)
  })

  it('should create a new instance when locale changes', () => {
    const b1 = getGlobalRelationshipBatcher({ apiRoute: '/api', locale: 'en', i18nLanguage: 'en' })
    const b2 = getGlobalRelationshipBatcher({ apiRoute: '/api', locale: 'es', i18nLanguage: 'es' })

    expect(b1).not.toBe(b2)
  })

  it('should throw when called without prior initialization', () => {
    resetGlobalRelationshipBatcher()
    expect(() => getGlobalRelationshipBatcher()).toThrow('RelationshipBatcher not initialized')
  })
})

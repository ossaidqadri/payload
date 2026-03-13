/**
 * Relationship field utilities for batching and caching
 *
 * These utilities help prevent N+1 query problems when loading
 * relationship fields in array/repeatable field contexts.
 */

import type { ClientCollectionConfig, ClientGlobalConfig } from 'payload'

import type { RelationshipBatcher } from '../../utilities/RelationshipBatcher.js'

/**
 * Configuration for building a list of relationships to fetch
 */
interface BuildRelationshipsToFetchConfig {
  relationMap: Record<string, (string | number)[]>
  getEntityConfig: (args: { collectionSlug: string }) =>
    | ClientCollectionConfig
    | ClientGlobalConfig
    | undefined
  options: Array<{ options?: Array<{ value: string | number; relationTo?: string }> }>
  batcher: RelationshipBatcher
}

/**
 * Relationship item to fetch
 */
export interface RelationshipToFetch {
  collection: ClientCollectionConfig | ClientGlobalConfig
  id: string
  fieldToSelect: string
}

/**
 * Build a list of relationships that need to be fetched.
 *
 * Filters out:
 * - Collections that cannot be resolved (skipped early rather than pushed with
 *   an `undefined` collection that callers must then guard against)
 * - Relationships already loaded in component state (options)
 * - Relationships already cached in the batcher
 *
 * @param config - Configuration object
 * @returns Array of relationships to fetch
 */
export function buildRelationshipsToFetch({
  relationMap,
  getEntityConfig,
  options,
  batcher,
}: BuildRelationshipsToFetchConfig): RelationshipToFetch[] {
  const relationshipsToFetch: RelationshipToFetch[] = []

  Object.entries(relationMap).forEach(([relation, ids]) => {
    const collection = getEntityConfig({ collectionSlug: relation })

    // Skip early when the collection config cannot be resolved to avoid
    // propagating undefined through the type and requiring defensive guards
    // at every call-site downstream.
    if (!collection) {
      return
    }

    const fieldToSelect = (collection?.admin as { useAsTitle?: string })?.useAsTitle || 'id'

    ids.forEach((id) => {
      // Check if already in options (cached in component state)
      const alreadyLoaded = options.some((optionGroup) =>
        optionGroup?.options?.some(
          (option) => option.value === id && option.relationTo === relation,
        ),
      )

      // Check if in batcher cache (normalise id to string for consistent lookup)
      const cachedInBatcher = batcher.getFromCache(relation, String(id)) !== null

      if (!alreadyLoaded && !cachedInBatcher) {
        relationshipsToFetch.push({
          collection,
          id: String(id),
          fieldToSelect,
        })
      }
    })
  })

  return relationshipsToFetch
}

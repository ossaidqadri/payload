import { expect, test } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

import { ensureCompilationIsDone } from '../../../__helpers/e2e/helpers.js'
import { initPayloadE2ENoConfig } from '../../../__helpers/shared/initPayloadE2ENoConfig.js'
import { AdminUrlUtil } from '../../../__helpers/shared/adminUrlUtil.js'
import { TEST_TIMEOUT_LONG } from '../../../playwright.config.js'
import { LexicalHelpers } from '../utils.js'
import { lexicalHeadingFeatureDisabledSlug } from '../../slugs.js'

const filename = fileURLToPath(import.meta.url)
const currentFolder = path.dirname(filename)
const dirname = path.resolve(currentFolder, '../../')

const { beforeAll, beforeEach, describe } = test

const { serverURL } = await initPayloadE2ENoConfig({
  dirname,
})

describe('Lexical Heading Feature - All Headings Disabled', () => {
  let lexical: LexicalHelpers

  beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(TEST_TIMEOUT_LONG)
    process.env.SEED_IN_CONFIG_ONINIT = 'false'
    const page = await browser.newPage()
    await ensureCompilationIsDone({ page, serverURL })
    await page.close()
  })

  beforeEach(async ({ page }) => {
    const url = new AdminUrlUtil(serverURL, lexicalHeadingFeatureDisabledSlug)
    lexical = new LexicalHelpers(page)
    await page.goto(url.create)
    await lexical.editor.first().focus()
  })

  test('markdown shortcut should not create h0 when all headings disabled', async () => {
    // Regression test for issue #15899:
    // When all heading sizes are disabled the markdown transformer regex degenerates
    // to /^()\s/, which matches any "# " prefix and produces an h0 node.
    await lexical.paste('markdown', '# Test Heading')

    // The text should remain as a paragraph — no h0 (invalid) or h1 (disabled)
    await expect(lexical.editor.locator('p')).toHaveCount(1)
    await expect(lexical.editor.locator('h0')).toHaveCount(0)
    await expect(lexical.editor.locator('h1')).toHaveCount(0)
  })

  test('multiple hash marks should not create invalid headings when all headings disabled', async () => {
    await lexical.paste('markdown', '## Test H2')
    await expect(lexical.editor.locator('h0')).toHaveCount(0)
    await expect(lexical.editor.locator('h2')).toHaveCount(0)
    await expect(lexical.editor.locator('p')).toHaveCount(1)

    await lexical.paste('markdown', '### Test H3')
    await expect(lexical.editor.locator('h0')).toHaveCount(0)
    await expect(lexical.editor.locator('h3')).toHaveCount(0)
  })
})

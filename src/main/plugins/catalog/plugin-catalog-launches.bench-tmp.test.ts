import { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../shared/plugins/catalog/plugin-install-link'
import { fetchPluginMarketplace as headFetch } from './plugin-marketplace-fetch'
import { fetchPluginMarketplace as baseFetch } from './plugin-marketplace-fetch.base-tmp'

type Launch = { at: number; sub: string }
const launches: Launch[] = []
const original = ChildProcess.prototype.spawn
ChildProcess.prototype.spawn = function (options: { args?: string[] }) {
  const args = options?.args ?? []
  const sub = args.slice(1).find((a) => !a.startsWith('-') && !a.includes('=')) ?? '?'
  launches.push({ at: performance.now(), sub })
  return original.call(this, options)
}

const sources = {
  community: { id: 'community', source: COMMUNITY_MARKETPLACE_GIT_SOURCE },
  official: {
    id: 'official',
    source: { kind: 'git', url: 'https://github.com/stablyai/orca-plugins.git', ref: 'main' }
  }
} as const

async function run(name: 'base' | 'head', key: keyof typeof sources) {
  const fetch = name === 'base' ? baseFetch : headFetch
  const from = launches.length
  const start = performance.now()
  // oxlint-disable-next-line typescript/no-explicit-any -- temporary benchmark
  const result = await fetch(sources[key] as any)
  const end = performance.now()
  const mine = launches.slice(from)
  const firstLsTree = mine.find((l) => l.sub === 'ls-tree')?.at ?? end
  const bySub: Record<string, number> = {}
  for (const l of mine) bySub[l.sub] = (bySub[l.sub] ?? 0) + 1
  const hash = createHash('sha256').update(JSON.stringify(result.marketplace))
  let imageBytes = 0
  for (const image of result.images ?? []) {
    hash.update(image)
    imageBytes += image.byteLength
  }
  const withImages = result.marketplace.plugins.filter((p) =>
    (p.releases ?? []).some((r) => r.images && Object.keys(r.images).length > 0)
  ).length
  console.log(
    'BENCH ' +
      JSON.stringify({
        name,
        catalog: key,
        commit: result.marketplaceCommit.slice(0, 10),
        launches: mine.length,
        bySub,
        readMs: Math.round(end - firstLsTree),
        totalMs: Math.round(end - start),
        plugins: result.marketplace.plugins.length,
        withImages,
        images: result.images?.length ?? 0,
        imageMB: +(imageBytes / 1048576).toFixed(1),
        output: hash.digest('hex').slice(0, 16)
      })
  )
}

describe('plugin catalog launch benchmark (temporary)', () => {
  it('base vs head', { timeout: 1_800_000 }, async () => {
    for (const key of ['community', 'official'] as const) {
      for (let i = 0; i < 3; i++) {
        await run(i % 2 === 0 ? 'base' : 'head', key)
        await run(i % 2 === 0 ? 'head' : 'base', key)
      }
    }
  })
})

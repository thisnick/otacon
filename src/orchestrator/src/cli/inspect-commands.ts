/**
 * `inspect commands` — print the otacon + otacon-alloc registry as a
 * human-readable reference. Used during prompt-engineering iterations to
 * inspect what the agent's `bash` tool can do without booting a server
 * or starting a run.
 *
 * No DB or FS dependencies — both registries are static metadata.
 */
import { otaconRegistry } from 'otacon-cli/commands/otacon'
import { buildAllocRegistryFs } from '../sandbox/alloc-commands-fs.js'
import type { AllocationStore } from '../storage/allocation-store.js'
import type { AllocationContext } from '../sandbox/allocation-context.js'

export async function inspectCommandsCommand(): Promise<void> {
  console.log('# otacon (phone control)')
  console.log('')
  for (const name of Object.keys(otaconRegistry).sort()) {
    const spec = otaconRegistry[name]
    console.log(`## ${spec.name}`)
    console.log(`  ${spec.description}`)
    console.log(`  usage:    ${spec.usage}`)
    console.log(`  mutating: ${spec.isMutating}`)
    if (spec.examples.length > 0) {
      console.log('  examples:')
      for (const ex of spec.examples) console.log(`    ${ex}`)
    }
    console.log('')
  }

  console.log('# otacon-alloc (phone allocation)')
  console.log('')
  // Placeholder context — buildAllocRegistryFs only consults
  // allocationStore/allocCtx inside `run()`, never at construction. Safe
  // to pass nulls here since we only enumerate static metadata.
  const placeholder = buildAllocRegistryFs({
    allocationStore: null as unknown as AllocationStore,
    accountId: '',
    runId: '',
    allocCtx: {
      peek: () => null,
      get: () => null,
      set: () => undefined,
      clear: () => undefined,
    } as unknown as AllocationContext,
  })
  for (const name of Object.keys(placeholder).sort()) {
    const spec = placeholder[name]
    console.log(`## ${spec.name}`)
    console.log(`  ${spec.description}`)
    console.log(`  usage: ${spec.usage}`)
    if (spec.examples.length > 0) {
      console.log('  examples:')
      for (const ex of spec.examples) console.log(`    ${ex}`)
    }
    console.log('')
  }
}

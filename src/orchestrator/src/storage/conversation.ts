/**
 * Conversation persistence: load/save conversation messages to blob storage.
 * Messages stored as individual JSON files at conversations/{id}/messages/00001.json
 */
import type { ModelMessage } from 'ai'
import type { BlobStore } from './blob.js'

export async function loadConversation(
  store: BlobStore,
  conversationId: string,
): Promise<ModelMessage[]> {
  const prefix = `conversations/${conversationId}/messages`
  const files = await store.list(prefix)
  if (files.length === 0) return []

  // Sort by filename (sequential numbering)
  const sorted = files.filter(f => f.endsWith('.json')).sort()
  const messages: ModelMessage[] = []

  for (const file of sorted) {
    const data = await store.read(file)
    if (data) {
      messages.push(JSON.parse(data.toString('utf-8')))
    }
  }

  return messages
}

export async function saveConversation(
  store: BlobStore,
  conversationId: string,
  messages: ModelMessage[],
): Promise<void> {
  const prefix = `conversations/${conversationId}/messages`

  // Write each message as a separate file with sequential numbering
  for (let i = 0; i < messages.length; i++) {
    const num = String(i + 1).padStart(5, '0')
    const filePath = `${prefix}/${num}.json`
    await store.write(filePath, JSON.stringify(messages[i], null, 2))
  }
}

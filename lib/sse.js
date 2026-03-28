/**
 * Consume an SSE stream using native fetch + ReadableStream.
 * Works in Node >= 18 with zero dependencies.
 */
export async function consumeSSE(url, { timeout = 300000, headers = {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  const res = await fetch(url, { signal: controller.signal, headers })
  if (!res.ok) {
    clearTimeout(timer)
    throw new Error(`SSE request failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let eventType = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete lines
      let newlineIdx
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)

        if (!line) {
          // Empty line = end of event (SSE spec), reset event type
          eventType = ''
          continue
        }

        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (!data) continue

          try {
            const parsed = JSON.parse(data)

            if (eventType === 'chunk') {
              fullText += parsed.text
            } else if (eventType === 'done') {
              clearTimeout(timer)
              return parsed.full_text || fullText
            }
            // Ignore status, presence, ping events — agent doesn't need them
          } catch {
            // Non-JSON data line, skip
          }
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return fullText || 'No answer received (timed out)'
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  return fullText || 'No answer received'
}

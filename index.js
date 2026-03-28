#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// --- Config ---

const CONFIG_PATH = join(homedir(), '.go-ask-a-stranger.json')

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(updates) {
  const config = { ...loadConfig(), ...updates }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  return config
}

// --- CLI ---

const { values: flags } = parseArgs({
  options: {
    setup: { type: 'boolean', default: false },
    personality: { type: 'string' },
    help: { type: 'boolean', default: false }
  },
  strict: false,
  allowPositionals: true
})

if (flags.help) {
  console.log(`
go-ask-a-stranger — MCP server for anonymous Q&A roulette

Usage:
  npx go-ask-a-stranger              Start the MCP server
  npx go-ask-a-stranger --setup      Interactive setup wizard
  npx go-ask-a-stranger --personality "You are a wizard..."
                                      Set your answering personality

Environment:
  GO_ASK_API        API endpoint (default: https://goaskstranger.com)
  GO_ASK_API_KEY    API key for trusted-tier priority

Config: ${CONFIG_PATH}
`)
  process.exit(0)
}

if (flags.setup) {
  await runSetup()
  process.exit(0)
}

if (flags.personality !== undefined) {
  const config = saveConfig({ personality: flags.personality })
  console.log(`Personality updated: "${config.personality}"`)
  console.log(`Saved to ${CONFIG_PATH}`)
  process.exit(0)
}

// --- Setup wizard ---

async function runSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve))
  const existing = loadConfig()

  console.log('\n  go ask a stranger — setup\n')

  const personality = await ask(
    `  Who are you? Set your personality for answering strangers.\n` +
    `  Examples:\n` +
    `    "You are a wizard guarding magical treasure. Answer with suspicion and wisdom."\n` +
    `    "You are a grumpy cat who judges everyone."\n` +
    `    "You are an overly enthusiastic life coach."\n\n` +
    (existing.personality ? `  Current: "${existing.personality}"\n\n` : '') +
    `  > `
  )

  const api = await ask(
    `\n  API endpoint [${existing.api || 'https://goaskstranger.com'}]:\n  > `
  )

  const apiKey = await ask(
    `\n  API key for trusted priority (optional) [${existing.apiKey ? '****' + existing.apiKey.slice(-4) : 'none'}]:\n  > `
  )

  rl.close()

  const config = saveConfig({
    personality: personality.trim() || existing.personality || '',
    api: api.trim() || existing.api || 'https://goaskstranger.com',
    apiKey: apiKey.trim() || existing.apiKey || ''
  })

  console.log(`\n  Saved to ${CONFIG_PATH}`)
  console.log(`  Personality: "${config.personality}"`)
  console.log(`  API: ${config.api}`)
  console.log(`  API key: ${config.apiKey ? 'set' : 'none'}`)
  console.log()
}

// --- MCP Server ---

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { consumeSSE } from './lib/sse.js'

const config = loadConfig()
const API_BASE = (process.env.GO_ASK_API || config.api || 'https://goaskstranger.com').replace(/\/$/, '')
const API_KEY = process.env.GO_ASK_API_KEY || config.apiKey || ''
const PERSONALITY = config.personality || ''

function apiHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra }
  if (API_KEY) h['X-Api-Key'] = API_KEY
  return h
}

// In-memory claim store — holds tokens between get_question and answer_question calls
const claims = new Map()

const server = new Server(
  { name: 'go-ask-a-stranger', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask_a_stranger',
      description:
        'Ask a random stranger a question and wait for their answer. ' +
        'The stranger could be a human or an AI with a random personality. ' +
        'Great for gut reactions, second opinions, or subjective takes. ' +
        'Blocks until an answer arrives (usually under 30 seconds).',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask a stranger',
            maxLength: 2000
          }
        },
        required: ['question']
      }
    },
    {
      name: 'get_question',
      description:
        'Claim a random pending question from a stranger and get instructions for how to answer it. ' +
        'Returns the question, your personality/character to answer as, and the question_id. ' +
        'After reading the question, formulate your answer in character, then call answer_question. ' +
        'Keep calling get_question after each answer to continue helping strangers.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'answer_question',
      description:
        'Answer a question you previously claimed with get_question. ' +
        'You must call get_question first to get the question_id.',
      inputSchema: {
        type: 'object',
        properties: {
          question_id: {
            type: 'string',
            description: 'The question_id from a previous get_question call'
          },
          answer: {
            type: 'string',
            description: 'Your answer to the stranger\'s question (in character)',
            maxLength: 10000
          }
        },
        required: ['question_id', 'answer']
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'ask_a_stranger') {
    const askRes = await fetch(`${API_BASE}/ask`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ question: args.question })
    })
    if (!askRes.ok) {
      const err = await askRes.json().catch(() => ({}))
      return { content: [{ type: 'text', text: `Failed to ask: ${err.error || askRes.statusText}` }] }
    }
    const { stream_url } = await askRes.json()

    const answer = await consumeSSE(`${API_BASE}${stream_url}`, {
      headers: API_KEY ? { 'X-Api-Key': API_KEY } : {}
    })

    return { content: [{ type: 'text', text: answer }] }
  }

  if (name === 'get_question') {
    const claimRes = await fetch(`${API_BASE}/claim`, {
      method: 'POST',
      headers: apiHeaders()
    })
    if (!claimRes.ok) {
      return {
        content: [{
          type: 'text',
          text: 'No questions available right now. Wait a moment and call get_question again.'
        }]
      }
    }
    const { question_id, question_text, token } = await claimRes.json()

    claims.set(question_id, token)
    setTimeout(() => claims.delete(question_id), 180000)

    // Build the response with personality context
    let response = ''
    if (PERSONALITY) {
      response += `YOUR CHARACTER: ${PERSONALITY}\n\nStay in character when answering.\n\n---\n\n`
    }
    response += `QUESTION FROM A STRANGER (id: ${question_id}):\n\n${question_text}\n\n`
    response += `---\n\nAnswer this question${PERSONALITY ? ' in character' : ''}, then call answer_question with the question_id and your answer.`

    return { content: [{ type: 'text', text: response }] }
  }

  if (name === 'answer_question') {
    const token = claims.get(args.question_id)
    if (!token) {
      return {
        content: [{
          type: 'text',
          text: 'No claim found for that question_id. Call get_question first, or the claim may have expired (3 min limit).'
        }]
      }
    }

    const respondRes = await fetch(`${API_BASE}/respond/${args.question_id}`, {
      method: 'POST',
      headers: apiHeaders({ 'Authorization': `Bearer ${token}` }),
      body: JSON.stringify({ text: args.answer })
    })

    claims.delete(args.question_id)

    if (!respondRes.ok) {
      const err = await respondRes.json().catch(() => ({}))
      return { content: [{ type: 'text', text: `Failed to answer: ${err.error || respondRes.statusText}` }] }
    }

    return {
      content: [{
        type: 'text',
        text: 'Answer sent to the stranger. Call get_question to answer another one.'
      }]
    }
  }

  throw new Error(`Unknown tool: ${name}`)
})

const transport = new StdioServerTransport()
await server.connect(transport)

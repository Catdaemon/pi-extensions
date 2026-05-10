import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import TurndownService from 'turndown'
import { htmlToText } from 'html-to-text'

const EXA_MCP_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : 'https://mcp.exa.ai/mcp'

const PI_WEB_SEARCH_DESCRIPTION = `- Search the web using Exa AI - performs real-time web searches and can scrape content from specific URLs
- Provides up-to-date information for current events and recent data
- Supports configurable result counts and returns the content from the most relevant websites
- Use this tool for accessing information beyond knowledge cutoff
- Searches are performed automatically within a single API call

Usage notes:
 - Supports live crawling modes: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)
 - Search types: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)
 - Configurable context length for optimal LLM integration
 - Domain filtering and advanced search options available

The current year is ${new Date().getFullYear()}. You MUST use this year when searching for recent information or current events`

const PI_WEB_FETCH_DESCRIPTION = `- Fetches content from a specified URL
- Takes a URL and optional format as input
- Fetches the URL content, converts to requested format (markdown by default)
- Returns the content in the specified format
- Use this tool when you need to retrieve and analyze web content

Usage notes:
 - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.
 - The URL must be a fully-formed valid URL
 - Format options: "markdown" (default), "text", or "html"
 - This tool is read-only and does not modify any files
 - Results may be summarized if the content is very large`

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_WEBFETCH_TIMEOUT_MS = 30 * 1000
const MAX_WEBFETCH_TIMEOUT_MS = 120 * 1000
const WEBSEARCH_TIMEOUT_MS = 25 * 1000

const webSearchParameters = Type.Object({
  query: Type.String({ description: 'Websearch query' }),
  numResults: Type.Optional(
    Type.Number({ description: 'Number of search results to return (default: 8)' })
  ),
  livecrawl: Type.Optional(
    Type.Union([
      Type.Literal('fallback'),
      Type.Literal('preferred'),
    ], {
      description:
        "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
    })
  ),
  type: Type.Optional(
    Type.Union([Type.Literal('auto'), Type.Literal('fast'), Type.Literal('deep')], {
      description:
        "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
    })
  ),
  contextMaxCharacters: Type.Optional(
    Type.Number({ description: 'Maximum characters for context string optimized for LLMs (default: 10000)' })
  ),
})

const webFetchParameters = Type.Object({
  url: Type.String({ description: 'The URL to fetch content from' }),
  format: Type.Optional(
    Type.Union([Type.Literal('text'), Type.Literal('markdown'), Type.Literal('html')], {
      description: 'The format to return the content in (text, markdown, or html). Defaults to markdown.',
    })
  ),
  timeout: Type.Optional(Type.Number({ description: 'Optional timeout in seconds (max 120)' })),
})

type WebsearchParams = {
  query: string
  numResults?: number
  livecrawl?: 'fallback' | 'preferred'
  type?: 'auto' | 'fast' | 'deep'
  contextMaxCharacters?: number
}

type WebfetchParams = {
  url: string
  format?: 'text' | 'markdown' | 'html'
  timeout?: number
}

type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id?: string | number | null
  result?: {
    content?: Array<{
      type?: string
      text?: string
    }>
  }
}

function createMergedSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timeoutId: NodeJS.Timeout | undefined

  const abort = () => controller.abort(parentSignal?.reason)

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason)
    } else {
      parentSignal.addEventListener('abort', abort, { once: true })
    }
  }

  timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (parentSignal) {
        parentSignal.removeEventListener('abort', abort)
      }
    },
  }
}

function parseExaSse(body: string) {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue
    }

    const data = JSON.parse(line.slice(6)) as JsonRpcSuccess
    const text = data.result?.content?.[0]?.text
    if (text) {
      return text
    }
  }

  return undefined
}

function getAcceptHeader(format: NonNullable<WebfetchParams['format']>) {
  switch (format) {
    case 'markdown':
      return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1'
    case 'text':
      return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
    case 'html':
      return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1'
  }
}

function isImageMimeType(mime: string) {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

function convertHtmlToMarkdown(html: string) {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  })

  turndownService.remove(['script', 'style', 'meta', 'link'])
  return turndownService.turndown(html)
}

function convertHtmlToPlainText(html: string) {
  return htmlToText(html, {
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
    wordwrap: false,
  }).trim()
}

export default function piWebTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description: PI_WEB_SEARCH_DESCRIPTION,
    promptSnippet: 'Search the web for current information beyond the model knowledge cutoff.',
    promptGuidelines: [
      'Use web_search for current events, recent documentation, or other live web information.',
      `When the user asks for latest or current information, include the current year (${new Date().getFullYear()}) in the query.`,
      'Use web_fetch when you already have a specific URL and need its contents.',
    ],
    parameters: webSearchParameters,
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      const params = rawParams as WebsearchParams

      onUpdate?.({
        content: [{ type: 'text', text: 'Searching the web with Exa MCP...' }],
        details: { status: 'pending' },
      })

      const payload = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: {
            query: params.query,
            type: params.type || 'auto',
            numResults: params.numResults || 8,
            livecrawl: params.livecrawl || 'fallback',
            contextMaxCharacters: params.contextMaxCharacters,
          },
        },
      }

      const { signal: mergedSignal, cleanup } = createMergedSignal(signal, WEBSEARCH_TIMEOUT_MS)

      try {
        const response = await fetch(EXA_MCP_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: mergedSignal,
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Search error (${response.status}): ${errorText}`)
        }

        const responseText = await response.text()
        const output = parseExaSse(responseText) ?? 'No search results found. Please try a different query.'

        return {
          content: [{ type: 'text', text: output }],
          details: {
            provider: 'exa-mcp',
            query: params.query,
            url: EXA_MCP_URL.replace(/exaApiKey=[^&]+/, 'exaApiKey=REDACTED'),
          },
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Search request timed out')
        }

        throw error
      } finally {
        cleanup()
      }
    },
  })

  pi.registerTool({
    name: 'web_fetch',
    label: 'Web Fetch',
    description: PI_WEB_FETCH_DESCRIPTION,
    promptSnippet: 'Fetch and read content from a specific URL.',
    promptGuidelines: [
      'Use web_fetch when you have a specific URL and need to retrieve its contents.',
      'Prefer format markdown unless the user specifically asks for text or raw html.',
    ],
    parameters: webFetchParameters,
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      const params = rawParams as WebfetchParams
      const format = params.format ?? 'markdown'

      if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://')
      }

      onUpdate?.({
        content: [{ type: 'text', text: `Fetching ${params.url}...` }],
        details: { status: 'pending' },
      })

      const timeoutMs = Math.min((params.timeout ?? DEFAULT_WEBFETCH_TIMEOUT_MS / 1000) * 1000, MAX_WEBFETCH_TIMEOUT_MS)
      const { signal: mergedSignal, cleanup } = createMergedSignal(signal, timeoutMs)
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        Accept: getAcceptHeader(format),
        'Accept-Language': 'en-US,en;q=0.9',
      }

      try {
        const initial = await fetch(params.url, {
          headers,
          signal: mergedSignal,
        })

        const response =
          initial.status === 403 && initial.headers.get('cf-mitigated') === 'challenge'
            ? await fetch(params.url, {
                headers: { ...headers, 'User-Agent': 'pi' },
                signal: mergedSignal,
              })
            : initial

        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`)
        }

        const contentLength = response.headers.get('content-length')
        if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
          throw new Error('Response too large (exceeds 5MB limit)')
        }

        const arrayBuffer = await response.arrayBuffer()
        if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
          throw new Error('Response too large (exceeds 5MB limit)')
        }

        const contentType = response.headers.get('content-type') || ''
        const mime = contentType.split(';')[0]?.trim().toLowerCase() || ''
        const title = `${params.url} (${contentType})`

        if (isImageMimeType(mime)) {
          return {
            content: [
              {
                type: 'text',
                text: 'Image fetched successfully',
              },
            ],
            details: {
              contentType,
              format,
              title,
              url: params.url,
            },
          }
        }

        const content = new TextDecoder().decode(arrayBuffer)
        let output = content

        if (format === 'markdown' && contentType.includes('text/html')) {
          output = convertHtmlToMarkdown(content)
        } else if (format === 'text' && contentType.includes('text/html')) {
          output = convertHtmlToPlainText(content)
        }

        return {
          content: [{ type: 'text', text: output }],
          details: {
            contentType,
            format,
            title,
            url: params.url,
          },
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Request timed out')
        }

        throw error
      } finally {
        cleanup()
      }
    },
  })
}

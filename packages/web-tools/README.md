# pi-web-tools

Web search and URL fetch tools for Pi.

## Why

Coding agents often need information that is newer than the model cutoff or available only on a specific web page. Without dedicated web tools, the agent either has to guess from stale knowledge or ask the user to paste external context manually.

`pi-web-tools` gives Pi bounded, explicit tools for live web lookup and URL fetching. It keeps web access separate from normal file tools, exposes clear prompt guidance, and limits response sizes so web content remains manageable inside an agent session.

This is especially useful for:

- Looking up current documentation, releases, APIs, and error messages
- Checking recent information that may be newer than the model cutoff
- Fetching a specific URL the user provides
- Converting web pages into markdown or plain text for easier analysis

## What it does

This Pi package adds two tools:

- **`web_search`**: searches the web through Exa MCP with configurable result count, search type, live-crawl mode, and context budget.
- **`web_fetch`**: fetches a specific HTTP(S) URL, bounds response size, and returns markdown, text, or raw HTML.

It also provides:

- Current-year prompt guidance for recent/current searches.
- HTML-to-markdown conversion through Turndown.
- HTML-to-text conversion for plain-text retrieval.
- Request timeouts and a maximum response size to keep outputs bounded.
- Basic image MIME handling so image URLs do not dump binary content.

## Install from npm

```bash
pi install npm:@catdaemon/pi-web-tools
```

Then reload Pi:

```text
/reload
```

## Runtime dependencies

`web_fetch` is self-contained.

`web_search` uses Exa MCP. Set `EXA_API_KEY` for authenticated Exa access; without it, the tool still targets the public Exa MCP endpoint but may be limited by Exa availability and access policy.

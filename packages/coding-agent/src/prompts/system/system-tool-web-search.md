# web_search

OMP system-tool definition exported from the stock tool registry.

## Token count

- Name: 2
- Description: 169
- JSON schema: 74
- Total: 245

## Description

Web search: current information beyond knowledge cutoff.

<instruction>
- SHOULD prefer primary sources (papers, official docs); corroborate key claims with multiple sources.
- MUST link cited sources in final response.
- NEVER use for programmatically accessible content or known URLs (GitHub repos/issues, known arXiv papers, Wikipedia pages, official docs) — `read` URL directly.
- `query`: every provider supports Google-style `site:`/`-site:`, `after:`/`before:` (`YYYY-MM-DD`), `inurl:`, `intitle:`, `filetype:`, `"exact phrase"`, `-term`, `OR`. Map constraints to native filters when available; otherwise filter results leniently. If a constraint matches nothing, relax and report it; do not return zero results.
</instruction>

## JSON schema

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string"
    },
    "recency": {
      "enum": [
        "day",
        "week",
        "month",
        "year"
      ],
      "type": "string"
    },
    "limit": {
      "type": "number"
    },
    "max_tokens": {
      "type": "number"
    },
    "temperature": {
      "type": "number"
    },
    "num_search_results": {
      "type": "number"
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}
```
